import { describe, expect, it } from "bun:test";
import type { FetchLike } from "../../src/auth/github-auth.ts";
import { createGitHubAdapter, GitHubNotFoundError, GitHubParamsFilterUnsupportedError } from "../../src/github/github.ts";
import { RateLimitError } from "../../src/http/rate-limit.ts";
import {
	asArtifactStore,
	asHistorical,
	asPipeliner,
	asRerunnable,
	asTriggerable,
	Capability,
	hasCapability,
} from "../../src/run/ci-backend.ts";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function ghRun(
	id: number,
	overrides: Partial<{ status: string; conclusion: string | null; created_at: string; run_started_at: string; updated_at: string }> = {},
) {
	return {
		id,
		name: "CI",
		status: overrides.status ?? "completed",
		conclusion: overrides.conclusion ?? "success",
		html_url: `https://github.com/o/r/actions/runs/${id}`,
		created_at: overrides.created_at ?? "2026-01-01T00:00:00Z",
		run_started_at: overrides.run_started_at,
		updated_at: overrides.updated_at,
	};
}

describe("createGitHubAdapter: construction performs no network I/O", () => {
	it("never calls fetch until an operation is invoked", () => {
		const fetchImpl: FetchLike = () => {
			throw new Error("fetch must not be called during construction");
		};
		expect(() => createGitHubAdapter({ name: "gh", owner: "o", repo: "r", token: "t", fetchImpl })).not.toThrow();
	});
});

describe("createGitHubAdapter.getRun: explicit run_id fidelity", () => {
	it("returns distinct results for two distinct explicit run IDs, never the same one twice", async () => {
		const fetchImpl: FetchLike = async (url) => {
			if (url.includes("/runs/1001")) return jsonResponse(ghRun(1001, { conclusion: "success" }));
			if (url.includes("/runs/1002")) return jsonResponse(ghRun(1002, { conclusion: "failure" }));
			throw new Error(`unexpected url: ${url}`);
		};
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl });

		const runA = await adapter.getRun("workflow.yml", "1001");
		const runB = await adapter.getRun("workflow.yml", "1002");
		expect(runA.id).toBe("1001");
		expect(runB.id).toBe("1002");
		expect(runA.status).toBe("success");
		expect(runB.status).toBe("failure");
	});

	it("routes runId=latest to a dedicated query, scoped to this exact workflow file -- not a guess at the most recently cached run, and not the repo's most recent run across every workflow", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse({ workflow_runs: [ghRun(9999)] });
		};
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl });

		const run = await adapter.getRun("workflow.yml", "latest");
		expect(run.id).toBe("9999");
		expect(requestedUrl).toContain("/actions/workflows/workflow.yml/runs?");
		expect(requestedUrl).not.toContain("/runs/latest");
	});

	it("getRun('latest') for two different workflow files in the same repo never collapses onto the same run -- confirmed live: ci.yml and publish.yml both resolving 'latest' to the identical run id", async () => {
		const fetchImpl: FetchLike = async (url) => {
			if (url.includes("/actions/workflows/ci.yml/runs")) return jsonResponse({ workflow_runs: [ghRun(111)] });
			if (url.includes("/actions/workflows/publish.yml/runs")) return jsonResponse({ workflow_runs: [ghRun(222)] });
			throw new Error(`unexpected url: ${url}`);
		};
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl });

		const ciRun = await adapter.getRun("ci.yml", "latest");
		const publishRun = await adapter.getRun("publish.yml", "latest");

		expect(ciRun.id).toBe("111");
		expect(publishRun.id).toBe("222");
	});

	it("throws GitHubNotFoundError, not a silent empty result, for a 404", async () => {
		const fetchImpl: FetchLike = async () => new Response("", { status: 404 });
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl });
		await expect(adapter.getRun("workflow.yml", "404")).rejects.toThrow(GitHubNotFoundError);
	});
});

describe("createGitHubAdapter: rate limiting", () => {
	it("throws RateLimitError on HTTP 429 with parsed headers", async () => {
		const fetchImpl: FetchLike = async () =>
			new Response("", { status: 429, headers: { "retry-after": "30", "x-ratelimit-remaining": "0", "x-ratelimit-limit": "60" } });
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl });

		await expect(adapter.getRun("workflow.yml", "1")).rejects.toThrow(RateLimitError);
	});

	it("recognizes the unprefixed RateLimit-* convention as well as X-RateLimit-*", async () => {
		const fetchImpl: FetchLike = async () => new Response("", { status: 429, headers: { "ratelimit-remaining": "0" } });
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl });
		await expect(adapter.getRun("workflow.yml", "1")).rejects.toThrow(RateLimitError);
	});
});

describe("createGitHubAdapter.trigger: two-phase receipt", () => {
	it("dispatches a workflow and resolves the run ID via created_at correlation", async () => {
		const dispatchedAt = new Date();
		const calls: string[] = [];
		const fetchImpl: FetchLike = async (url, init) => {
			calls.push(`${init?.method ?? "GET"} ${url}`);
			if (url.includes("/dispatches")) return new Response("", { status: 204 });
			if (url.includes("event=workflow_dispatch")) {
				return jsonResponse({ workflow_runs: [ghRun(555, { created_at: new Date(dispatchedAt.getTime() + 1000).toISOString() })] });
			}
			throw new Error(`unexpected url: ${url}`);
		};
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", token: "tok", fetchImpl });

		const receipt = await adapter.trigger("deploy.yml", { environment: "prod" });
		expect(receipt.needsResolve).toBe(true);
		expect(calls[0]).toContain("POST");
		expect(calls[0]).toContain("/workflows/deploy.yml/dispatches");

		const resolved = await adapter.resolveReceipt(receipt);
		expect(resolved.needsResolve).toBe(false);
		expect(resolved.runId).toBe("555");
	});

	it("keeps needsResolve=true when no matching run has appeared yet", async () => {
		const fetchImpl: FetchLike = async (url) => {
			if (url.includes("/dispatches")) return new Response("", { status: 204 });
			return jsonResponse({ workflow_runs: [] });
		};
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl });

		const receipt = await adapter.trigger("deploy.yml", {});
		const resolved = await adapter.resolveReceipt(receipt);
		expect(resolved.needsResolve).toBe(true);
	});
});

describe("createGitHubAdapter.getLog: per-job concatenation, not the zipped run-level endpoint", () => {
	it("fetches each job's log and concatenates with a header", async () => {
		const fetchImpl: FetchLike = async (url) => {
			if (url.includes("/jobs") && !url.includes("/logs")) {
				return jsonResponse({ jobs: [{ id: 1, name: "build", status: "completed", conclusion: "success", started_at: null }] });
			}
			if (url.includes("/jobs/1/logs")) return new Response("line one\nline two", { status: 200 });
			throw new Error(`unexpected url: ${url}`);
		};
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl });

		const log = await adapter.getLog("workflow.yml", "1", {});
		expect(log).toContain("--- build ---");
		expect(log).toContain("line one\nline two");
	});
});

describe("createGitHubAdapter.getRun: durationMs", () => {
	it("computes durationMs from run_started_at/updated_at for a completed run", async () => {
		const fetchImpl: FetchLike = async () =>
			jsonResponse(ghRun(1, { run_started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:05:00Z" }));
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl });

		const run = await adapter.getRun("workflow.yml", "1");
		expect(run.durationMs).toBe(5 * 60 * 1000);
	});

	it("leaves durationMs undefined for a still-running run", async () => {
		const fetchImpl: FetchLike = async () =>
			jsonResponse(ghRun(1, { status: "in_progress", conclusion: null, run_started_at: "2026-01-01T00:00:00Z" }));
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl });

		const run = await adapter.getRun("workflow.yml", "1");
		expect(run.durationMs).toBeUndefined();
	});
});

describe("createGitHubAdapter.estimateDuration", () => {
	it("averages durationMs across recent completed runs of the workflow", async () => {
		const fetchImpl: FetchLike = async (url) => {
			expect(url).toContain("/actions/workflows/workflow.yml/runs?status=completed");
			return jsonResponse({
				workflow_runs: [
					ghRun(1, { run_started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:10:00Z" }),
					ghRun(2, { run_started_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:20:00Z" }),
				],
			});
		};
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl });
		const triggerable = asTriggerable(adapter);

		const estimatedMs = await triggerable?.estimateDuration("workflow.yml");
		expect(estimatedMs).toBe(15 * 60 * 1000);
	});

	it("returns 0 when no completed runs exist yet", async () => {
		const fetchImpl: FetchLike = async () => jsonResponse({ workflow_runs: [] });
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl });
		const triggerable = asTriggerable(adapter);

		expect(await triggerable?.estimateDuration("workflow.yml")).toBe(0);
	});
});

describe("createGitHubAdapter: capabilities", () => {
	it("advertises trigger, history, stages, and artifacts but not chain", () => {
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r" });
		const caps = adapter.capabilities();
		expect(hasCapability(caps, Capability.Trigger)).toBe(true);
		expect(hasCapability(caps, Capability.History)).toBe(true);
		expect(hasCapability(caps, Capability.Stages)).toBe(true);
		expect(hasCapability(caps, Capability.Artifacts)).toBe(true);
		expect(hasCapability(caps, Capability.Rerun)).toBe(true);
		expect(hasCapability(caps, Capability.Chain)).toBe(false);

		expect(asTriggerable(adapter)).toBeDefined();
		expect(asHistorical(adapter)).toBeDefined();
		expect(asPipeliner(adapter)).toBeDefined();
		expect(asArtifactStore(adapter)).toBeDefined();
		expect(asRerunnable(adapter)).toBeDefined();
	});
});

describe("createGitHubAdapter stages and reruns", () => {
	it("maps jobs and their steps into stage nodes", async () => {
		const fetchImpl: FetchLike = async () =>
			jsonResponse({
				jobs: [
					{
						id: 7,
						name: "benchmark",
						status: "completed",
						conclusion: "failure",
						started_at: "2026-01-01T00:00:00Z",
						completed_at: "2026-01-01T00:02:00Z",
						steps: [
							{
								number: 3,
								name: "Run benchmark",
								status: "completed",
								conclusion: "failure",
								started_at: "2026-01-01T00:00:10Z",
								completed_at: "2026-01-01T00:01:50Z",
							},
						],
					},
				],
			});
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl });

		const stages = await adapter.listStageNodes("workflow.yml", "42");

		expect(stages).toEqual([
			{
				id: "7",
				name: "benchmark",
				status: "failure",
				durationMs: 120_000,
				steps: [{ id: "3", name: "Run benchmark", status: "failure", durationMs: 100_000 }],
			},
		]);
	});

	it("reruns all jobs or failed jobs through distinct GitHub endpoints", async () => {
		const requests: string[] = [];
		const fetchImpl: FetchLike = async (url, init) => {
			requests.push(`${init?.method ?? "GET"} ${url}`);
			return new Response("", { status: 201 });
		};
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl });
		const rerunnable = asRerunnable(adapter);

		await rerunnable?.rerun("workflow.yml", "42", false);
		await rerunnable?.rerun("workflow.yml", "42", true);

		expect(requests[0]).toContain("POST https://api.github.com/repos/o/r/actions/runs/42/rerun");
		expect(requests[1]).toContain("POST https://api.github.com/repos/o/r/actions/runs/42/rerun-failed-jobs");
	});
});

describe("createGitHubAdapter.listArtifacts", () => {
	it("maps GitHub artifact fields to the domain shape", async () => {
		const fetchImpl: FetchLike = async () => jsonResponse({ artifacts: [{ id: 42, name: "report.xml", size_in_bytes: 1024 }] });
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl });

		const artifacts = await adapter.listArtifacts("workflow.yml", "1");
		expect(artifacts).toEqual([{ name: "report.xml", path: "42", sizeBytes: 1024 }]);
	});

	it("stops artifact downloads at the caller's byte ceiling", async () => {
		const fetchImpl: FetchLike = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl });

		await expect(adapter.getArtifact("workflow.yml", "1", "42", 2)).rejects.toThrow(/exceeds maxBytes 2/);
	});
});

describe("createGitHubAdapter: account-scoped (no repo given) -- repo comes from jobRef, per call", () => {
	it("two different repos through the same adapter instance route to two different, correctly distinct repos, never the same one twice", async () => {
		const requestedUrls: string[] = [];
		const fetchImpl: FetchLike = async (url) => {
			requestedUrls.push(url);
			if (url.includes("/repos/o/alpha/actions/runs/1")) return jsonResponse(ghRun(1, { conclusion: "success" }));
			if (url.includes("/repos/o/beta/actions/runs/2")) return jsonResponse(ghRun(2, { conclusion: "failure" }));
			throw new Error(`unexpected url: ${url}`);
		};
		const adapter = createGitHubAdapter({ name: "account-scoped", owner: "o", fetchImpl });

		const runAlpha = await adapter.getRun("alpha/ci.yml", "1");
		const runBeta = await adapter.getRun("beta/ci.yml", "2");

		expect(runAlpha.id).toBe("1");
		expect(runAlpha.status).toBe("success");
		expect(runBeta.id).toBe("2");
		expect(runBeta.status).toBe("failure");
		expect(requestedUrls[0]).toContain("/repos/o/alpha/");
		expect(requestedUrls[1]).toContain("/repos/o/beta/");
	});

	it("trigger() dispatches to the repo named in jobRef, and the resulting receipt's own jobRef lets resolveReceipt route back to that same repo", async () => {
		const calls: string[] = [];
		const dispatchedAt = new Date();
		const fetchImpl: FetchLike = async (url, init) => {
			calls.push(`${init?.method ?? "GET"} ${url}`);
			if (url.includes("/repos/o/beta/actions/workflows/deploy.yml/dispatches")) return new Response("", { status: 204 });
			if (url.includes("/repos/o/beta/actions/runs?event=workflow_dispatch")) {
				return jsonResponse({ workflow_runs: [ghRun(777, { created_at: new Date(dispatchedAt.getTime() + 1000).toISOString() })] });
			}
			throw new Error(`unexpected url: ${url}`);
		};
		const adapter = createGitHubAdapter({ name: "account-scoped", owner: "o", fetchImpl });

		const receipt = await adapter.trigger("beta/deploy.yml", {});
		expect(receipt.jobRef).toBe("beta/deploy.yml");
		const resolved = await adapter.resolveReceipt(receipt);
		expect(resolved.runId).toBe("777");
	});

	it("a bare workflow name (no repo qualifier) fails loudly, never silently misrouting to some assumed repo", async () => {
		const adapter = createGitHubAdapter({ name: "account-scoped", owner: "o", fetchImpl: async () => new Response("") });
		await expect(adapter.getRun("ci.yml", "1")).rejects.toThrow(
			'GitHub backend "account-scoped" is account-scoped -- jobRef must be "repo/workflow.yml"',
		);
	});

	it("a repo-pinned adapter (repo given) still treats the whole jobRef as the workflow name, unchanged from before this became optional", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse(ghRun(1));
		};
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl });
		await adapter.getRun("nested/looking/workflow.yml", "1");
		expect(requestedUrl).toContain("/repos/o/r/actions/runs/1");
	});
});

describe("createGitHubAdapter: discovery", () => {
	it("listRepos() filters /user/repos down to this adapter's own owner, mapping to the domain shape", async () => {
		const fetchImpl: FetchLike = async () =>
			jsonResponse([
				{ name: "pipes", full_name: "DanyPops/pipes", private: false, owner: { login: "DanyPops" } },
				{ name: "secrets-repo", full_name: "DanyPops/secrets-repo", private: true, owner: { login: "DanyPops" } },
				{ name: "other-owner-repo", full_name: "someone-else/other-owner-repo", private: false, owner: { login: "someone-else" } },
			]);
		const adapter = createGitHubAdapter({ name: "account-scoped", owner: "DanyPops", fetchImpl });

		const repos = await adapter.listRepos();
		expect(repos).toEqual([
			{ name: "pipes", fullName: "DanyPops/pipes", private: false },
			{ name: "secrets-repo", fullName: "DanyPops/secrets-repo", private: true },
		]);
	});

	it("listRepos() requests one bounded page (100), never an unbounded fetch", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse([]);
		};
		const adapter = createGitHubAdapter({ name: "account-scoped", owner: "DanyPops", fetchImpl });
		await adapter.listRepos();
		expect(requestedUrl).toContain("/user/repos?per_page=100");
	});

	it("listWorkflows(repo) maps each workflow's path to just its file name -- the exact jobRef-valid string", async () => {
		const fetchImpl: FetchLike = async () =>
			jsonResponse({
				workflows: [
					{ name: "Publish", path: ".github/workflows/publish.yml", state: "active" },
					{ name: "CI", path: ".github/workflows/ci.yml", state: "active" },
				],
			});
		const adapter = createGitHubAdapter({ name: "account-scoped", owner: "o", fetchImpl });

		const workflows = await adapter.listWorkflows("pipes");
		expect(workflows).toEqual([
			{ name: "Publish", fileName: "publish.yml", state: "active" },
			{ name: "CI", fileName: "ci.yml", state: "active" },
		]);
	});

	it("listWorkflows(repo) uses the given repo directly against the right upstream URL", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse({ workflows: [] });
		};
		const adapter = createGitHubAdapter({ name: "account-scoped", owner: "o", fetchImpl });
		await adapter.listWorkflows("beta");
		expect(requestedUrl).toContain("/repos/o/beta/actions/workflows");
	});

	it("is advertised as a capability -- asDiscoverable resolves, and the capability set includes Discover", () => {
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r" });
		expect(hasCapability(adapter.capabilities(), Capability.Discover)).toBe(true);
	});
});

describe("createGitHubAdapter.searchRuns", () => {
	it("paginates via GitHub's own page= param to actually reach a `since` far enough back in history", async () => {
		const since = new Date("2026-01-01T00:00:00Z");
		const requestedUrls: string[] = [];
		const fetchImpl: FetchLike = async (url) => {
			requestedUrls.push(url);
			if (url.includes("page=1")) {
				return jsonResponse({
					workflow_runs: [ghRun(104, { created_at: "2026-01-05T00:00:00Z" }), ghRun(103, { created_at: "2026-01-04T00:00:00Z" })],
				});
			}
			if (url.includes("page=2")) {
				return jsonResponse({
					workflow_runs: [ghRun(102, { created_at: "2026-01-03T00:00:00Z" }), ghRun(101, { created_at: "2025-12-20T00:00:00Z" })],
				});
			}
			throw new Error(`unexpected url: ${url}`);
		};
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl, searchPageSize: 2, searchMaxPages: 10 });

		const result = await adapter.searchRuns("ci.yml", { since, limit: 100 });

		expect(requestedUrls).toHaveLength(2); // stopped as soon as `since` was crossed
		expect(result.runs.map((r) => r.id)).toEqual(["104", "103", "102"]); // #101 predates since, correctly excluded
		expect(result.truncated).toBe(false);
	});

	it("throws rather than silently ignoring filter.params -- GitHub Actions exposes no way to retrieve dispatch inputs after the fact", async () => {
		let calls = 0;
		const fetchImpl: FetchLike = async () => {
			calls++;
			return jsonResponse({ workflow_runs: [ghRun(1)] }); // would silently "succeed" if params filtering were skipped
		};
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl });

		await expect(adapter.searchRuns("ci.yml", { params: { HOST: "kni-qe-79" } })).rejects.toThrow(GitHubParamsFilterUnsupportedError);
		expect(calls).toBe(0); // fails before ever hitting the network -- not a filtered-then-discarded fetch
	});

	it("reports truncated:true when the page-cap safety valve is hit before `since` is ever reached", async () => {
		const farSince = new Date(0);
		let requests = 0;
		const fetchImpl: FetchLike = async () => {
			requests++;
			return jsonResponse({
				workflow_runs: [ghRun(200, { created_at: "2026-06-01T00:00:00Z" }), ghRun(199, { created_at: "2026-06-01T00:00:00Z" })],
			});
		};
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl, searchPageSize: 2, searchMaxPages: 3 });

		const result = await adapter.searchRuns("ci.yml", { since: farSince, limit: 1000 });

		expect(requests).toBe(3);
		expect(result.truncated).toBe(true);
	});

	it("reports truncated:false once real history runs out (a short final page)", async () => {
		const farSince = new Date(0);
		const fetchImpl: FetchLike = async () => jsonResponse({ workflow_runs: [ghRun(1, { created_at: "2026-01-01T00:00:00Z" })] });
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl, searchPageSize: 50, searchMaxPages: 200 });

		const result = await adapter.searchRuns("ci.yml", { since: farSince });

		expect(result.runs.map((r) => r.id)).toEqual(["1"]);
		expect(result.truncated).toBe(false);
	});

	it("stops as soon as `limit` is satisfied, without needing a second page", async () => {
		let requests = 0;
		const fetchImpl: FetchLike = async () => {
			requests++;
			return jsonResponse({ workflow_runs: [ghRun(2), ghRun(1)] });
		};
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl, searchPageSize: 2, searchMaxPages: 200 });

		const result = await adapter.searchRuns("ci.yml", { limit: 1 });

		expect(requests).toBe(1);
		expect(result.runs.map((r) => r.id)).toEqual(["2"]);
		expect(result.truncated).toBe(false);
	});
});

import { describe, expect, it } from "bun:test";
import type { FetchLike } from "../../../src/adapters/github/auth.ts";
import { createGitHubAdapter, GitHubNotFoundError } from "../../../src/adapters/github/github-adapter.ts";
import { RateLimitError } from "../../../src/adapters/http-rate-limit.ts";
import { asArtifactStore, asHistorical, asPipeliner, asTriggerable, hasCapability, Capability } from "../../../src/ports/ci-backend.ts";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function ghRun(id: number, overrides: Partial<{ status: string; conclusion: string | null; created_at: string }> = {}) {
	return {
		id,
		name: "CI",
		status: overrides.status ?? "completed",
		conclusion: overrides.conclusion ?? "success",
		html_url: `https://github.com/o/r/actions/runs/${id}`,
		created_at: overrides.created_at ?? "2026-01-01T00:00:00Z",
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

	it("routes runId=latest to a dedicated query, not a guess at the most recently cached run", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse({ workflow_runs: [ghRun(9999)] });
		};
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl });

		const run = await adapter.getRun("workflow.yml", "latest");
		expect(run.id).toBe("9999");
		expect(requestedUrl).toContain("/actions/runs?per_page=1");
		expect(requestedUrl).not.toContain("/runs/latest");
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

describe("createGitHubAdapter: capabilities", () => {
	it("advertises trigger, history, stages, and artifacts but not chain", () => {
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r" });
		const caps = adapter.capabilities();
		expect(hasCapability(caps, Capability.Trigger)).toBe(true);
		expect(hasCapability(caps, Capability.History)).toBe(true);
		expect(hasCapability(caps, Capability.Stages)).toBe(true);
		expect(hasCapability(caps, Capability.Artifacts)).toBe(true);
		expect(hasCapability(caps, Capability.Chain)).toBe(false);

		expect(asTriggerable(adapter)).toBeDefined();
		expect(asHistorical(adapter)).toBeDefined();
		expect(asPipeliner(adapter)).toBeDefined();
		expect(asArtifactStore(adapter)).toBeDefined();
	});
});

describe("createGitHubAdapter.listArtifacts", () => {
	it("maps GitHub artifact fields to the domain shape", async () => {
		const fetchImpl: FetchLike = async () => jsonResponse({ artifacts: [{ id: 42, name: "report.xml", size_in_bytes: 1024 }] });
		const adapter = createGitHubAdapter({ name: "gh", owner: "o", repo: "r", fetchImpl });

		const artifacts = await adapter.listArtifacts("workflow.yml", "1");
		expect(artifacts).toEqual([{ name: "report.xml", path: "42", sizeBytes: 1024 }]);
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
		await expect(adapter.getRun("ci.yml", "1")).rejects.toThrow('GitHub backend "account-scoped" is account-scoped -- jobRef must be "repo/workflow.yml"');
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

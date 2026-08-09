import { describe, expect, it } from "bun:test";
import type { FetchLike } from "../../src/auth/github-auth.ts";
import { createJenkinsAdapter, JenkinsNotFoundError } from "../../src/jenkins/jenkins.ts";
import {
	asArtifactStore,
	asChainable,
	asDiscoverable,
	asHistorical,
	asPipeliner,
	asTriggerable,
	Capability,
	hasCapability,
} from "../../src/run/ci-backend.ts";

const CREDENTIALS = { baseUrl: "https://jenkins.example.com", username: "alice", apiToken: "tok123" };

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

describe("createJenkinsAdapter: construction performs no network I/O", () => {
	it("never calls fetch until an operation is invoked", () => {
		const fetchImpl: FetchLike = () => {
			throw new Error("fetch must not be called during construction");
		};
		expect(() => createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl })).not.toThrow();
	});
});

describe("createJenkinsAdapter.getRun: explicit run_id fidelity", () => {
	it("returns distinct results for two distinct explicit run IDs", async () => {
		const fetchImpl: FetchLike = async (url) => {
			if (url.includes("/job/deploy/101/api/json"))
				return jsonResponse({ number: 101, result: "SUCCESS", building: false, url: "u", timestamp: 1 });
			if (url.includes("/job/deploy/102/api/json"))
				return jsonResponse({ number: 102, result: "FAILURE", building: false, url: "u", timestamp: 2 });
			throw new Error(`unexpected url: ${url}`);
		};
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl });

		const runA = await adapter.getRun("deploy", "101");
		const runB = await adapter.getRun("deploy", "102");
		expect(runA.id).toBe("101");
		expect(runB.id).toBe("102");
		expect(runA.status).toBe("success");
		expect(runB.status).toBe("failure");
	});

	it("routes runId=latest to Jenkins' own lastBuild alias", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse({ number: 999, result: "SUCCESS", building: false, url: "u", timestamp: 1 });
		};
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl });

		const run = await adapter.getRun("deploy", "latest");
		expect(run.id).toBe("999");
		expect(requestedUrl).toContain("/job/deploy/lastBuild/api/json");
	});

	it("maps folder-style job refs to Jenkins' nested job/ path segments", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse({ number: 1, result: "SUCCESS", building: false, url: "u", timestamp: 1 });
		};
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl });
		await adapter.getRun("CI/deploy", "1");
		expect(requestedUrl).toContain("/job/CI/job/deploy/1/api/json");
	});

	it("throws JenkinsNotFoundError, not a silent empty result, for a 404", async () => {
		const fetchImpl: FetchLike = async () => new Response("", { status: 404 });
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl });
		await expect(adapter.getRun("deploy", "404")).rejects.toThrow(JenkinsNotFoundError);
	});

	it("treats a running build as status running regardless of a stale result field", async () => {
		const fetchImpl: FetchLike = async () => jsonResponse({ number: 1, result: null, building: true, url: "u", timestamp: 1 });
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl });
		const run = await adapter.getRun("deploy", "1");
		expect(run.status).toBe("running");
	});
});

describe("createJenkinsAdapter.trigger: queue-item resolution", () => {
	it("attaches Basic auth and a fetched crumb to the trigger POST", async () => {
		const seenHeaders: Record<string, string>[] = [];
		const fetchImpl: FetchLike = async (url, init) => {
			if (url.includes("crumbIssuer")) return jsonResponse({ crumb: "c1", crumbRequestField: "Jenkins-Crumb" });
			if (url.includes("/build")) {
				seenHeaders.push((init?.headers as Record<string, string>) ?? {});
				return new Response("", { status: 201, headers: { location: "https://jenkins.example.com/queue/item/42/" } });
			}
			throw new Error(`unexpected url: ${url}`);
		};
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl });

		const receipt = await adapter.trigger("deploy", {});
		expect(receipt.needsResolve).toBe(true);
		expect(receipt.opaqueRef).toBe("https://jenkins.example.com/queue/item/42/");
		expect(seenHeaders[0]?.["Jenkins-Crumb"]).toBe("c1");
		expect(seenHeaders[0]?.authorization).toContain("Basic ");
	});

	it("posts to buildWithParameters when params are given", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			if (url.includes("crumbIssuer")) return new Response("", { status: 404 });
			requestedUrl = url;
			return new Response("", { status: 201, headers: { location: "https://jenkins.example.com/queue/item/1/" } });
		};
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl });
		await adapter.trigger("deploy", { VERSION: "5.0" });
		expect(requestedUrl).toContain("/buildWithParameters?");
		expect(requestedUrl).toContain("VERSION=5.0");
	});

	it("resolveReceipt stays pending while the queue item has no executable yet, then resolves once it does", async () => {
		let queueCall = 0;
		const fetchImpl: FetchLike = async (url) => {
			if (url.includes("/queue/item/42/api/json")) {
				queueCall++;
				if (queueCall === 1) return jsonResponse({});
				return jsonResponse({ executable: { number: 77 } });
			}
			throw new Error(`unexpected url: ${url}`);
		};
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl });

		const receipt = { backend: "j", jobRef: "deploy", needsResolve: true, opaqueRef: "https://jenkins.example.com/queue/item/42/" };
		const first = await adapter.resolveReceipt(receipt);
		expect(first.needsResolve).toBe(true);
		const second = await adapter.resolveReceipt(receipt);
		expect(second.needsResolve).toBe(false);
		expect(second.runId).toBe("77");
	});

	it("throws when the queue item was cancelled rather than silently reporting still-pending", async () => {
		const fetchImpl: FetchLike = async (url) => {
			if (url.includes("/queue/item/42/api/json")) return jsonResponse({ cancelled: true });
			throw new Error(`unexpected url: ${url}`);
		};
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl });
		const receipt = { backend: "j", jobRef: "deploy", needsResolve: true, opaqueRef: "https://jenkins.example.com/queue/item/42/" };
		await expect(adapter.resolveReceipt(receipt)).rejects.toThrow(/cancelled/);
	});
});

describe("createJenkinsAdapter: crumb retry on 403", () => {
	it("refetches the crumb once and retries after a 403", async () => {
		let crumbFetches = 0;
		let postAttempts = 0;
		const fetchImpl: FetchLike = async (url) => {
			if (url.includes("crumbIssuer")) {
				crumbFetches++;
				return jsonResponse({ crumb: `c${crumbFetches}`, crumbRequestField: "Jenkins-Crumb" });
			}
			if (url.includes("/stop")) {
				postAttempts++;
				if (postAttempts === 1) return new Response("stale crumb", { status: 403 });
				return new Response("", { status: 200 });
			}
			throw new Error(`unexpected url: ${url}`);
		};
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl });

		await adapter.cancelRun("deploy", "1");
		expect(postAttempts).toBe(2);
		expect(crumbFetches).toBe(2); // refetched after the 403
	});
});

describe("createJenkinsAdapter.getLog", () => {
	it("returns plain console text, not JSON", async () => {
		const fetchImpl: FetchLike = async (url) => {
			expect(url).toContain("/consoleText");
			return new Response("build log line 1\nbuild log line 2", { status: 200 });
		};
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl });
		const log = await adapter.getLog("deploy", "1", {});
		expect(log).toBe("build log line 1\nbuild log line 2");
	});
});

describe("createJenkinsAdapter.listStageNodesWithLogs", () => {
	it("attaches a failed step's log but leaves successful steps alone", async () => {
		const fetchImpl: FetchLike = async (url) => {
			if (url.includes("wfapi/describe") && !url.includes("execution/node")) {
				return jsonResponse({ stages: [{ id: "3", name: "deploy", status: "FAILED", durationMillis: 100 }] });
			}
			if (url.includes("execution/node/3/wfapi/describe")) {
				return jsonResponse({
					stageFlowNodes: [
						{ id: "5", name: "step-ok", status: "SUCCESS", durationMillis: 10 },
						{ id: "6", name: "step-bad", status: "FAILED", durationMillis: 20 },
					],
				});
			}
			if (url.includes("execution/node/6/wfapi/log")) return jsonResponse({ text: "boom: connection refused" });
			throw new Error(`unexpected url: ${url}`);
		};
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl });

		const nodes = await adapter.listStageNodesWithLogs("deploy", "1");
		const steps = nodes[0]?.steps ?? [];
		expect(steps.find((s) => s.name === "step-ok")?.failedLog).toBeUndefined();
		expect(steps.find((s) => s.name === "step-bad")?.failedLog).toBe("boom: connection refused");
	});
});

describe("createJenkinsAdapter.listArtifacts", () => {
	it("maps fileName/relativePath to the domain shape", async () => {
		const fetchImpl: FetchLike = async () => jsonResponse({ artifacts: [{ fileName: "report.xml", relativePath: "reports/report.xml" }] });
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl });
		const artifacts = await adapter.listArtifacts("deploy", "1");
		expect(artifacts).toEqual([{ name: "report.xml", path: "reports/report.xml" }]);
	});
});

describe("createJenkinsAdapter: capabilities", () => {
	it("advertises trigger, history, stages, artifacts, chain, and discover", () => {
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS });
		const caps = adapter.capabilities();
		expect(hasCapability(caps, Capability.Trigger)).toBe(true);
		expect(hasCapability(caps, Capability.History)).toBe(true);
		expect(hasCapability(caps, Capability.Stages)).toBe(true);
		expect(hasCapability(caps, Capability.Artifacts)).toBe(true);
		expect(hasCapability(caps, Capability.Chain)).toBe(true);
		expect(hasCapability(caps, Capability.Discover)).toBe(true);

		expect(asTriggerable(adapter)).toBeDefined();
		expect(asHistorical(adapter)).toBeDefined();
		expect(asPipeliner(adapter)).toBeDefined();
		expect(asArtifactStore(adapter)).toBeDefined();
		expect(asChainable(adapter)).toBeDefined();
		expect(asDiscoverable(adapter)).toBeDefined();
	});
});

describe("createJenkinsAdapter.listRepos", () => {
	it("maps the instance root's top-level jobs/folders to RepoInfo, both foldered and buildable", async () => {
		const fetchImpl: FetchLike = async (url) => {
			expect(url).toContain("/api/json?tree=jobs[name,url,color]");
			return jsonResponse({
				jobs: [
					{ name: "CI", url: "u/CI/" }, // a folder: no color field at all
					{ name: "deploy", url: "u/deploy/", color: "blue" },
				],
			});
		};
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl });

		const repos = await adapter.listRepos();
		expect(repos).toEqual([
			{ name: "CI", fullName: "CI", private: false },
			{ name: "deploy", fullName: "deploy", private: false },
		]);
	});

	it("returns an empty list, not an error, for an instance with zero jobs", async () => {
		const fetchImpl: FetchLike = async () => jsonResponse({ jobs: [] });
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl });
		expect(await adapter.listRepos()).toEqual([]);
	});
});

describe("createJenkinsAdapter.listWorkflows", () => {
	it("lists a folder's child jobs as real, immediately-usable folder-nested jobRefs", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse({
				name: "CI",
				jobs: [
					{ name: "deploy", url: "u", color: "blue" },
					{ name: "sub", url: "u" }, // a nested folder
				],
			});
		};
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl });

		const workflows = await adapter.listWorkflows("CI");
		expect(requestedUrl).toContain("/job/CI/api/json");
		expect(workflows).toEqual([
			{ name: "deploy", fileName: "CI/deploy", state: "blue" },
			{ name: "sub", fileName: "CI/sub", state: "folder" },
		]);
	});

	it("returns the job itself as a single workflow when repo already names a leaf job, not a folder", async () => {
		const fetchImpl: FetchLike = async () => jsonResponse({ name: "deploy", color: "blue" }); // no `jobs` key -- a real, non-folder job
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl });

		const workflows = await adapter.listWorkflows("deploy");
		expect(workflows).toEqual([{ name: "deploy", fileName: "deploy", state: "job" }]);
	});

	it("builds correct nested jobRefs for a folder several levels deep", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse({ name: "sub", jobs: [{ name: "deploy", url: "u", color: "red" }] });
		};
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl });

		const workflows = await adapter.listWorkflows("CI/sub");
		expect(requestedUrl).toContain("/job/CI/job/sub/api/json");
		expect(workflows).toEqual([{ name: "deploy", fileName: "CI/sub/deploy", state: "red" }]);
	});

	it("throws JenkinsNotFoundError, not a silent empty result, for a repo that doesn't exist", async () => {
		const fetchImpl: FetchLike = async () => new Response("", { status: 404 });
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl });
		await expect(adapter.listWorkflows("missing")).rejects.toThrow(JenkinsNotFoundError);
	});
});

describe("createJenkinsAdapter.getDownstreamRuns", () => {
	function buildWithCause(number: number, upstreamProject: string, upstreamBuild: number) {
		return {
			number,
			result: "SUCCESS",
			building: false,
			url: `u/${number}`,
			timestamp: 1,
			actions: [{ causes: [{ upstreamProject, upstreamBuild }] }],
		};
	}

	it("keeps only downstream builds whose cause chain matches the exact upstream project and build number", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse({
				builds: [
					buildWithCause(10, "upstream", 5), // matches
					buildWithCause(11, "upstream", 6), // different upstream build number
					buildWithCause(12, "other-job", 5), // different upstream project
				],
			});
		};
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl });

		const runs = await adapter.getDownstreamRuns("downstream", "upstream", "5");

		expect(requestedUrl).toContain("/job/downstream/api/json");
		expect(requestedUrl).toContain("{0,50}"); // bounded scan, not an open-ended fetch
		expect(runs.map((r) => r.id)).toEqual(["10"]);
	});

	it("matches the upstream project name case-insensitively, like Jenkins' own project name handling", async () => {
		const fetchImpl: FetchLike = async () => jsonResponse({ builds: [buildWithCause(20, "Upstream-Job", 5)] });
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl });

		const runs = await adapter.getDownstreamRuns("downstream", "upstream-job", "5");

		expect(runs.map((r) => r.id)).toEqual(["20"]);
	});

	it("returns an empty list, not an error, when no downstream build matches", async () => {
		const fetchImpl: FetchLike = async () => jsonResponse({ builds: [buildWithCause(30, "unrelated", 99)] });
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl });

		expect(await adapter.getDownstreamRuns("downstream", "upstream", "5")).toEqual([]);
	});

	it("rejects a non-numeric upstream run id rather than silently matching nothing", async () => {
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS });
		await expect(adapter.getDownstreamRuns("downstream", "upstream", "not-a-number")).rejects.toThrow(/invalid upstream run id/);
	});
});

/** A minimal Jenkins build entry for the search endpoint's own tree shape, newest-timestamp-first like the real API. */
function searchBuild(number: number, result: string, timestampMs: number, params?: Record<string, string>): unknown {
	return {
		number,
		result,
		building: false,
		timestamp: timestampMs,
		url: `https://jenkins.example.com/job/deploy/${number}/`,
		fullDisplayName: `deploy #${number}`,
		actions: params ? [{ parameters: Object.entries(params).map(([name, value]) => ({ name, value })) }] : [],
	};
}

describe("createJenkinsAdapter.searchRuns", () => {
	it("paginates past a single fixed-size page to actually reach a `since` far enough back in history", async () => {
		// Page 1 (2 builds, both after since) -- old fixed-window behavior would have stopped here.
		// Page 2 (2 builds: one after since, one before -- must stop there, not keep paging).
		const since = new Date(1_700_000_000_000);
		const requestedUrls: string[] = [];
		const fetchImpl: FetchLike = async (url) => {
			requestedUrls.push(url);
			const decoded = decodeURIComponent(url);
			if (decoded.includes("{0,2}")) {
				return jsonResponse({
					builds: [searchBuild(104, "SUCCESS", since.getTime() + 4000), searchBuild(103, "SUCCESS", since.getTime() + 3000)],
				});
			}
			if (decoded.includes("{2,4}")) {
				return jsonResponse({
					builds: [searchBuild(102, "SUCCESS", since.getTime() + 2000), searchBuild(101, "SUCCESS", since.getTime() - 1000)],
				});
			}
			throw new Error(`unexpected url: ${url}`);
		};
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl, searchPageSize: 2, searchMaxPages: 10 });

		const result = await adapter.searchRuns("deploy", { since, limit: 100 });

		expect(requestedUrls).toHaveLength(2); // exactly 2 pages -- stopped as soon as `since` was crossed
		expect(result.runs.map((r) => r.id)).toEqual(["104", "103", "102"]); // #101 is before since, correctly excluded
		expect(result.truncated).toBe(false);
	});

	it("filters on params, excluding a build whose real parameters don't match every requested key", async () => {
		const fetchImpl: FetchLike = async () =>
			jsonResponse({
				builds: [
					searchBuild(3, "SUCCESS", 3000, { ENV: "prod", HOST: "kni-qe-79" }), // matches both
					searchBuild(2, "SUCCESS", 2000, { ENV: "staging", HOST: "kni-qe-79" }), // wrong ENV
					searchBuild(1, "SUCCESS", 1000, { ENV: "prod", HOST: "kni-qe-86" }), // wrong HOST
				],
			});
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl });

		const result = await adapter.searchRuns("deploy", { params: { ENV: "prod", HOST: "kni-qe-79" } });

		expect(result.runs.map((r) => r.id)).toEqual(["3"]);
	});

	it("reports truncated:true when the page-cap safety valve is hit before `since` is ever reached", async () => {
		const farSince = new Date(0); // never crossed by any page below -- forces the cap
		let requests = 0;
		const fetchImpl: FetchLike = async () => {
			requests++;
			// Always a full page, newer-than-since, so the loop never finds a natural stopping point.
			return jsonResponse({ builds: [searchBuild(200, "SUCCESS", 5_000_000), searchBuild(199, "SUCCESS", 4_000_000)] });
		};
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl, searchPageSize: 2, searchMaxPages: 3 });

		const result = await adapter.searchRuns("deploy", { since: farSince, limit: 1000 });

		expect(requests).toBe(3); // exactly the page cap -- gave up, didn't hang forever
		expect(result.truncated).toBe(true);
	});

	it("reports truncated:false once real history runs out (a short final page), even under a `since` that predates every build", async () => {
		const farSince = new Date(0);
		const fetchImpl: FetchLike = async () => jsonResponse({ builds: [searchBuild(1, "SUCCESS", 1000)] }); // shorter than the page size -- end of history
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl, searchPageSize: 50, searchMaxPages: 200 });

		const result = await adapter.searchRuns("deploy", { since: farSince });

		expect(result.runs.map((r) => r.id)).toEqual(["1"]);
		expect(result.truncated).toBe(false);
	});

	it("stops as soon as `limit` is satisfied, without needing to reach `since` or run out of history", async () => {
		let requests = 0;
		const fetchImpl: FetchLike = async () => {
			requests++;
			return jsonResponse({ builds: [searchBuild(2, "SUCCESS", 2000), searchBuild(1, "SUCCESS", 1000)] });
		};
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS, fetchImpl, searchPageSize: 2, searchMaxPages: 200 });

		const result = await adapter.searchRuns("deploy", { limit: 1 });

		expect(requests).toBe(1);
		expect(result.runs.map((r) => r.id)).toEqual(["2"]);
		expect(result.truncated).toBe(false);
	});
});

import { describe, expect, it } from "bun:test";
import type { FetchLike } from "../../src/auth/github-auth.ts";
import { createJenkinsAdapter, JenkinsNotFoundError } from "../../src/jenkins/jenkins.ts";
import {
	asArtifactStore,
	asChainable,
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
	it("advertises trigger, history, stages, artifacts, and chain", () => {
		const adapter = createJenkinsAdapter({ name: "j", credentials: CREDENTIALS });
		const caps = adapter.capabilities();
		expect(hasCapability(caps, Capability.Trigger)).toBe(true);
		expect(hasCapability(caps, Capability.History)).toBe(true);
		expect(hasCapability(caps, Capability.Stages)).toBe(true);
		expect(hasCapability(caps, Capability.Artifacts)).toBe(true);
		expect(hasCapability(caps, Capability.Chain)).toBe(true);

		expect(asTriggerable(adapter)).toBeDefined();
		expect(asHistorical(adapter)).toBeDefined();
		expect(asPipeliner(adapter)).toBeDefined();
		expect(asArtifactStore(adapter)).toBeDefined();
		expect(asChainable(adapter)).toBeDefined();
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

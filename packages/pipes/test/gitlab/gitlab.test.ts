import { describe, expect, it } from "bun:test";
import type { FetchLike } from "../../src/auth/github-auth.ts";
import { createGitLabAdapter, GitLabNotFoundError } from "../../src/gitlab/gitlab.ts";
import { RateLimitError } from "../../src/http/rate-limit.ts";
import {
	asArtifactStore,
	asChainable,
	asHistorical,
	asPipeliner,
	asTriggerable,
	Capability,
	hasCapability,
} from "../../src/run/ci-backend.ts";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function glPipeline(id: number, overrides: Partial<{ status: string; created_at: string }> = {}) {
	return {
		id,
		ref: "main",
		status: overrides.status ?? "success",
		web_url: `https://gitlab.example.com/p/-/pipelines/${id}`,
		created_at: overrides.created_at ?? "2026-01-01T00:00:00Z",
	};
}

describe("createGitLabAdapter: construction performs no network I/O", () => {
	it("never calls fetch until an operation is invoked", () => {
		const fetchImpl: FetchLike = () => {
			throw new Error("fetch must not be called during construction");
		};
		expect(() => createGitLabAdapter({ name: "gl", baseUrl: "https://gitlab.example.com", projectId: "1", fetchImpl })).not.toThrow();
	});
});

describe("createGitLabAdapter.getRun: explicit run_id fidelity", () => {
	it("returns distinct results for two distinct explicit pipeline IDs", async () => {
		const fetchImpl: FetchLike = async (url) => {
			if (url.includes("/pipelines/201")) return jsonResponse(glPipeline(201, { status: "success" }));
			if (url.includes("/pipelines/202")) return jsonResponse(glPipeline(202, { status: "failed" }));
			throw new Error(`unexpected url: ${url}`);
		};
		const adapter = createGitLabAdapter({ name: "gl", baseUrl: "https://gitlab.example.com", projectId: "1", fetchImpl });

		const runA = await adapter.getRun("main", "201");
		const runB = await adapter.getRun("main", "202");
		expect(runA.id).toBe("201");
		expect(runB.id).toBe("202");
		expect(runA.status).toBe("success");
		expect(runB.status).toBe("failure");
	});

	it("routes runId=latest to a dedicated newest-first query, not a guess", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse([glPipeline(999)]);
		};
		const adapter = createGitLabAdapter({ name: "gl", baseUrl: "https://gitlab.example.com", projectId: "1", fetchImpl });

		const run = await adapter.getRun("main", "latest");
		expect(run.id).toBe("999");
		expect(requestedUrl).toContain("order_by=id");
		expect(requestedUrl).toContain("sort=desc");
		expect(requestedUrl).not.toContain("/pipelines/latest");
	});

	it("throws GitLabNotFoundError, not a silent empty result, for a 404", async () => {
		const fetchImpl: FetchLike = async () => new Response("", { status: 404 });
		const adapter = createGitLabAdapter({ name: "gl", baseUrl: "https://gitlab.example.com", projectId: "1", fetchImpl });
		await expect(adapter.getRun("main", "404")).rejects.toThrow(GitLabNotFoundError);
	});
});

describe("createGitLabAdapter: rate limiting", () => {
	it("throws RateLimitError on HTTP 429", async () => {
		const fetchImpl: FetchLike = async () => new Response("", { status: 429, headers: { "retry-after": "10" } });
		const adapter = createGitLabAdapter({ name: "gl", baseUrl: "https://gitlab.example.com", projectId: "1", fetchImpl });
		await expect(adapter.getRun("main", "1")).rejects.toThrow(RateLimitError);
	});

	it("recognizes GitLab's unprefixed RateLimit-* headers", async () => {
		const fetchImpl: FetchLike = async () => new Response("", { status: 429, headers: { "ratelimit-remaining": "0" } });
		const adapter = createGitLabAdapter({ name: "gl", baseUrl: "https://gitlab.example.com", projectId: "1", fetchImpl });
		await expect(adapter.getRun("main", "1")).rejects.toThrow(RateLimitError);
	});
});

describe("createGitLabAdapter.trigger: synchronous pipeline ID, no resolve loop needed", () => {
	it("returns needsResolve=false immediately with the pipeline ID GitLab assigned", async () => {
		const fetchImpl: FetchLike = async (url, init) => {
			expect(init?.method).toBe("POST");
			expect(url).toContain("/pipeline");
			return jsonResponse(glPipeline(555, { status: "pending" }));
		};
		const adapter = createGitLabAdapter({ name: "gl", baseUrl: "https://gitlab.example.com", projectId: "1", token: "tok", fetchImpl });

		const receipt = await adapter.trigger("main", { VERSION: "5.0" });
		expect(receipt.needsResolve).toBe(false);
		expect(receipt.runId).toBe("555");

		const resolved = await adapter.resolveReceipt(receipt);
		expect(resolved).toEqual(receipt); // resolveReceipt is a no-op — already resolved
	});

	it("sends non-ref params as pipeline variables", async () => {
		let capturedBody: unknown;
		const fetchImpl: FetchLike = async (_url, init) => {
			capturedBody = JSON.parse(init?.body as string);
			return jsonResponse(glPipeline(1));
		};
		const adapter = createGitLabAdapter({ name: "gl", baseUrl: "https://gitlab.example.com", projectId: "1", fetchImpl });
		await adapter.trigger("main", { ref: "develop", ENV: "staging" });
		expect(capturedBody).toEqual({ ref: "develop", variables: [{ key: "ENV", value: "staging" }] });
	});
});

describe("createGitLabAdapter.getLog", () => {
	it("concatenates each job's trace with a header, matching GitHub's per-job approach", async () => {
		const fetchImpl: FetchLike = async (url) => {
			if (url.includes("/jobs") && !url.includes("/trace")) {
				return jsonResponse([{ id: 1, name: "build", stage: "build", status: "success", created_at: "2026-01-01T00:00:00Z" }]);
			}
			if (url.includes("/jobs/1/trace")) return new Response("trace line 1\ntrace line 2", { status: 200 });
			throw new Error(`unexpected url: ${url}`);
		};
		const adapter = createGitLabAdapter({ name: "gl", baseUrl: "https://gitlab.example.com", projectId: "1", fetchImpl });
		const log = await adapter.getLog("main", "1", {});
		expect(log).toContain("--- build ---");
		expect(log).toContain("trace line 1\ntrace line 2");
	});
});

describe("createGitLabAdapter.listStageNodesWithLogs", () => {
	it("attaches a failed job's trace but leaves successful jobs alone", async () => {
		const fetchImpl: FetchLike = async (url) => {
			if (url.includes("/jobs") && !url.includes("/trace")) {
				return jsonResponse([
					{ id: 1, name: "build", stage: "build", status: "success", created_at: "2026-01-01T00:00:00Z" },
					{ id: 2, name: "test", stage: "test", status: "failed", created_at: "2026-01-01T00:00:00Z" },
				]);
			}
			if (url.includes("/jobs/2/trace")) return new Response("assertion failed: expected true", { status: 200 });
			throw new Error(`unexpected url: ${url}`);
		};
		const adapter = createGitLabAdapter({ name: "gl", baseUrl: "https://gitlab.example.com", projectId: "1", fetchImpl });

		const nodes = await adapter.listStageNodesWithLogs("main", "1");
		const buildStep = nodes.find((n) => n.name === "build")?.steps?.[0];
		const testStep = nodes.find((n) => n.name === "test")?.steps?.[0];
		expect(buildStep?.failedLog).toBeUndefined();
		expect(testStep?.failedLog).toBe("assertion failed: expected true");
	});
});

describe("createGitLabAdapter.listArtifacts / getArtifact", () => {
	it("namespaces artifact paths by job ID so getArtifact can route back to the right job", async () => {
		const fetchImpl: FetchLike = async (url) => {
			if (url.includes("/jobs") && !url.includes("/artifacts")) {
				return jsonResponse([
					{
						id: 7,
						name: "build",
						stage: "build",
						status: "success",
						created_at: "2026-01-01T00:00:00Z",
						artifacts: [{ filename: "report.xml", size: 512 }],
					},
				]);
			}
			throw new Error(`unexpected url: ${url}`);
		};
		const adapter = createGitLabAdapter({ name: "gl", baseUrl: "https://gitlab.example.com", projectId: "1", fetchImpl });
		const artifacts = await adapter.listArtifacts("main", "1");
		expect(artifacts).toEqual([{ name: "report.xml", path: "7/report.xml", sizeBytes: 512 }]);
	});

	it("fetches the artifact bytes from the job-scoped endpoint encoded in the path", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
		};
		const adapter = createGitLabAdapter({ name: "gl", baseUrl: "https://gitlab.example.com", projectId: "1", fetchImpl });
		const bytes = await adapter.getArtifact("main", "1", "7/report.xml");
		expect(requestedUrl).toContain("/jobs/7/artifacts/report.xml");
		expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
	});
});

describe("createGitLabAdapter: capabilities", () => {
	it("advertises trigger, history, stages, artifacts, and chain", () => {
		const adapter = createGitLabAdapter({ name: "gl", baseUrl: "https://gitlab.example.com", projectId: "1" });
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

describe("createGitLabAdapter.getDownstreamRuns", () => {
	it("maps each bridge's downstream_pipeline to a CIRun via trigger_jobs", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse([
				{ downstream_pipeline: glPipeline(501, { status: "running" }) },
				{ downstream_pipeline: glPipeline(502, { status: "success" }) },
			]);
		};
		const adapter = createGitLabAdapter({ name: "gl", baseUrl: "https://gitlab.example.com", projectId: "1", fetchImpl });

		const runs = await adapter.getDownstreamRuns("ignored", "ignored", "100");

		expect(requestedUrl).toContain("/pipelines/100/trigger_jobs");
		expect(runs.map((r) => r.id)).toEqual(["501", "502"]);
		expect(runs[1]?.status).toBe("success");
	});

	it("skips trigger jobs whose downstream pipeline hasn't been created yet", async () => {
		const fetchImpl: FetchLike = async () => jsonResponse([{ downstream_pipeline: null }, { downstream_pipeline: glPipeline(503) }]);
		const adapter = createGitLabAdapter({ name: "gl", baseUrl: "https://gitlab.example.com", projectId: "1", fetchImpl });

		const runs = await adapter.getDownstreamRuns("ignored", "ignored", "100");

		expect(runs.map((r) => r.id)).toEqual(["503"]);
	});

	it("falls back to the deprecated bridges path on 404, for self-managed instances predating GitLab 19.2", async () => {
		const requestedUrls: string[] = [];
		const fetchImpl: FetchLike = async (url) => {
			requestedUrls.push(url);
			if (url.includes("/trigger_jobs")) return new Response("", { status: 404 });
			return jsonResponse([{ downstream_pipeline: glPipeline(504) }]);
		};
		const adapter = createGitLabAdapter({ name: "gl", baseUrl: "https://gitlab.example.com", projectId: "1", fetchImpl });

		const runs = await adapter.getDownstreamRuns("ignored", "ignored", "100");

		expect(requestedUrls.some((u) => u.includes("/trigger_jobs"))).toBe(true);
		expect(requestedUrls.some((u) => u.includes("/bridges"))).toBe(true);
		expect(runs.map((r) => r.id)).toEqual(["504"]);
	});
});

describe("createGitLabAdapter.searchRuns", () => {
	it("paginates via GitLab's own page= param to actually reach a `since` far enough back in history", async () => {
		const since = new Date("2026-01-01T00:00:00Z");
		const requestedUrls: string[] = [];
		const fetchImpl: FetchLike = async (url) => {
			requestedUrls.push(url);
			if (url.includes("page=1")) {
				return jsonResponse([
					glPipeline(104, { created_at: "2026-01-05T00:00:00Z" }),
					glPipeline(103, { created_at: "2026-01-04T00:00:00Z" }),
				]);
			}
			if (url.includes("page=2")) {
				return jsonResponse([
					glPipeline(102, { created_at: "2026-01-03T00:00:00Z" }),
					glPipeline(101, { created_at: "2025-12-20T00:00:00Z" }),
				]);
			}
			throw new Error(`unexpected url: ${url}`);
		};
		const adapter = createGitLabAdapter({
			name: "gl",
			baseUrl: "https://gitlab.example.com",
			projectId: "1",
			fetchImpl,
			searchPageSize: 2,
			searchMaxPages: 10,
		});

		const result = await adapter.searchRuns("main", { since, limit: 100 });

		expect(requestedUrls).toHaveLength(2); // stopped as soon as `since` was crossed
		expect(result.runs.map((r) => r.id)).toEqual(["104", "103", "102"]); // #101 predates since, correctly excluded
		expect(result.truncated).toBe(false);
	});

	it("filters on params via a per-candidate /variables fetch, excluding a pipeline whose real variables don't match every requested key", async () => {
		const variablesByPipeline: Record<string, Array<{ key: string; value: string }>> = {
			"3": [
				{ key: "ENV", value: "prod" },
				{ key: "HOST", value: "kni-qe-79" },
			], // matches both
			"2": [
				{ key: "ENV", value: "staging" },
				{ key: "HOST", value: "kni-qe-79" },
			], // wrong ENV
			"1": [
				{ key: "ENV", value: "prod" },
				{ key: "HOST", value: "kni-qe-86" },
			], // wrong HOST
		};
		const fetchImpl: FetchLike = async (url) => {
			if (url.endsWith("/variables") || url.includes("/variables?")) {
				const match = url.match(/pipelines\/(\d+)\/variables/);
				const id = match?.[1] ?? "";
				return jsonResponse(variablesByPipeline[id] ?? []);
			}
			return jsonResponse([glPipeline(3), glPipeline(2), glPipeline(1)]);
		};
		const adapter = createGitLabAdapter({ name: "gl", baseUrl: "https://gitlab.example.com", projectId: "1", fetchImpl });

		const result = await adapter.searchRuns("main", { params: { ENV: "prod", HOST: "kni-qe-79" } });

		expect(result.runs.map((r) => r.id)).toEqual(["3"]);
	});

	it("reports truncated:true when the page-cap safety valve is hit before `since` is ever reached", async () => {
		const farSince = new Date(0);
		let requests = 0;
		const fetchImpl: FetchLike = async () => {
			requests++;
			return jsonResponse([
				glPipeline(200, { created_at: "2026-06-01T00:00:00Z" }),
				glPipeline(199, { created_at: "2026-06-01T00:00:00Z" }),
			]);
		};
		const adapter = createGitLabAdapter({
			name: "gl",
			baseUrl: "https://gitlab.example.com",
			projectId: "1",
			fetchImpl,
			searchPageSize: 2,
			searchMaxPages: 3,
		});

		const result = await adapter.searchRuns("main", { since: farSince, limit: 1000 });

		expect(requests).toBe(3);
		expect(result.truncated).toBe(true);
	});

	it("reports truncated:false once real history runs out (a short final page)", async () => {
		const farSince = new Date(0);
		const fetchImpl: FetchLike = async () => jsonResponse([glPipeline(1, { created_at: "2026-01-01T00:00:00Z" })]);
		const adapter = createGitLabAdapter({
			name: "gl",
			baseUrl: "https://gitlab.example.com",
			projectId: "1",
			fetchImpl,
			searchPageSize: 50,
			searchMaxPages: 200,
		});

		const result = await adapter.searchRuns("main", { since: farSince });

		expect(result.runs.map((r) => r.id)).toEqual(["1"]);
		expect(result.truncated).toBe(false);
	});

	it("stops as soon as `limit` is satisfied, without needing a second page", async () => {
		let requests = 0;
		const fetchImpl: FetchLike = async () => {
			requests++;
			return jsonResponse([glPipeline(2), glPipeline(1)]);
		};
		const adapter = createGitLabAdapter({
			name: "gl",
			baseUrl: "https://gitlab.example.com",
			projectId: "1",
			fetchImpl,
			searchPageSize: 2,
			searchMaxPages: 200,
		});

		const result = await adapter.searchRuns("main", { limit: 1 });

		expect(requests).toBe(1);
		expect(result.runs.map((r) => r.id)).toEqual(["2"]);
		expect(result.truncated).toBe(false);
	});
});

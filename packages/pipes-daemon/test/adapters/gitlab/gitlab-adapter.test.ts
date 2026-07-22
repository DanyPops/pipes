import { describe, expect, it } from "bun:test";
import type { FetchLike } from "../../../src/adapters/github/auth.ts";
import { createGitLabAdapter, GitLabNotFoundError } from "../../../src/adapters/gitlab/gitlab-adapter.ts";
import { RateLimitError } from "../../../src/adapters/http-rate-limit.ts";
import { asArtifactStore, asHistorical, asPipeliner, asTriggerable, Capability, hasCapability } from "../../../src/ports/ci-backend.ts";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function glPipeline(id: number, overrides: Partial<{ status: string; created_at: string }> = {}) {
	return { id, ref: "main", status: overrides.status ?? "success", web_url: `https://gitlab.example.com/p/-/pipelines/${id}`, created_at: overrides.created_at ?? "2026-01-01T00:00:00Z" };
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
				return jsonResponse([{ id: 7, name: "build", stage: "build", status: "success", created_at: "2026-01-01T00:00:00Z", artifacts: [{ filename: "report.xml", size: 512 }] }]);
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
	it("advertises trigger, history, stages, and artifacts but not chain", () => {
		const adapter = createGitLabAdapter({ name: "gl", baseUrl: "https://gitlab.example.com", projectId: "1" });
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

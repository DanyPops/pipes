import { describe, expect, it } from "bun:test";
import { openPipesDb } from "../src/db.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { Capability } from "../src/ports/ci-backend.ts";
import { createRunPool } from "../src/run-pool.ts";
import { createPipesService } from "../src/service.ts";
import { createStubCIBackend } from "./fixtures/stub-ci-backend.ts";

describe("ci.status", () => {
	it("returns a verdict for backend+jobRef", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", run: { id: "1", name: "run", status: "success", startedAt: new Date(0) } }));
		const service = createPipesService(orchestrator);

		const result = await service.execute("ci.status", { backend: "gh", jobRef: "job" });
		expect(result.verdict).toBeDefined();
		expect(result.pipelineRun).toBeUndefined();
	});

	it("returns a pipelineRun when pipeline is given instead of backend/jobRef", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", capabilities: Capability.Trigger, run: { id: "1", name: "run", status: "success", startedAt: new Date(0) } }),
		);
		orchestrator.registerPipeline({ name: "deploy", backend: "gh", steps: [{ jobName: "build" }] });
		const service = createPipesService(orchestrator);

		await service.execute("ci.trigger", { pipeline: "deploy" });
		const result = await service.execute("ci.status", { pipeline: "deploy" });
		expect(result.pipelineRun?.status).toBe("success");
	});

	it("rejects a status call with neither pipeline nor backend/jobRef", async () => {
		const service = createPipesService(new Orchestrator());
		await expect(service.execute("ci.status", {})).rejects.toThrow(/backend and jobRef are required/);
	});
});

describe("ci.trigger", () => {
	it("returns a TriggerResult for a raw backend+jobRef trigger", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", capabilities: Capability.Trigger, triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "7" } }),
		);
		const service = createPipesService(orchestrator);

		const result = await service.execute("ci.trigger", { backend: "gh", jobRef: "job", params: {} });
		expect(result.result?.buildNumber).toBe("7");
	});
});

describe("ci.wait", () => {
	it("resolves immediately once the watched run reaches a terminal status", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", capabilities: Capability.Trigger, run: { id: "1", name: "run", status: "success", startedAt: new Date(0) } }),
		);
		const service = createPipesService(orchestrator, { waitPollIntervalMs: 1 });

		const result = await service.execute("ci.wait", { backend: "gh", jobRef: "job", runId: "1", timeoutS: 5 });
		expect("status" in result && result.status).toBe("success");
	});

	it("polls until timeout and returns the last known status when the run never terminates", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", capabilities: Capability.Trigger, run: { id: "1", name: "run", status: "running", startedAt: new Date(0) } }),
		);
		const service = createPipesService(orchestrator, { waitPollIntervalMs: 5 });

		const start = Date.now();
		const result = await service.execute("ci.wait", { backend: "gh", jobRef: "job", runId: "1", timeoutS: 0.02 });
		expect("status" in result && result.status).toBe("running");
		expect(Date.now() - start).toBeLessThan(1000); // bounded by timeoutS, not left hanging
	});

	it("resolves an opaqueRef without watching a run", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", capabilities: Capability.Trigger, resolvedReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "99" } }),
		);
		const service = createPipesService(orchestrator);

		const result = await service.execute("ci.wait", { backend: "gh", opaqueRef: "queue-1" });
		expect(result).toEqual({ buildNumber: "99" });
	});
});

describe("ci.cancel", () => {
	it("maps NotOwnedError to an HTTP-mappable rejection rather than silently succeeding", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "gh" }));
		const service = createPipesService(orchestrator);

		await expect(service.execute("ci.cancel", { backend: "gh", jobRef: "job", runId: "1" })).rejects.toThrow(/not owned/);
	});

	it("succeeds once the run was triggered through ci.trigger in this session", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", capabilities: Capability.Trigger, triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "7" } }),
		);
		const service = createPipesService(orchestrator);

		await service.execute("ci.trigger", { backend: "gh", jobRef: "job", params: {} });
		const result = await service.execute("ci.cancel", { backend: "gh", jobRef: "job", runId: "7" });
		expect(result).toEqual({ status: "cancelled", runId: "7" });
	});
});

describe("ci.search", () => {
	it("passes filter fields through to the orchestrator, parsing since as a Date", async () => {
		const orchestrator = new Orchestrator();
		const run = { id: "1", name: "run", status: "success" as const, startedAt: new Date("2026-01-01T00:00:00Z") };
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", searchResults: [run] }));
		const service = createPipesService(orchestrator);

		const result = await service.execute("ci.search", { backend: "gh", jobRef: "job", since: "2026-01-01T00:00:00Z" });
		expect(result.builds).toEqual([run]);
	});
});

describe("ci.help", () => {
	it("lists configured backends and registered pipelines", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", capabilities: Capability.Trigger }));
		orchestrator.registerPipeline({ name: "deploy", backend: "gh", steps: [] });
		const service = createPipesService(orchestrator);

		const result = await service.execute("ci.help", {});
		expect(result.backends).toEqual([{ name: "gh", type: "stub", capabilities: "trigger" }]);
		expect(result.pipelines).toEqual(["deploy"]);
	});
});

describe("ci.pool", () => {
	it("returns an empty list when no run pool is configured, rather than throwing", async () => {
		const service = createPipesService(new Orchestrator());
		const result = await service.execute("ci.pool", { backend: "gh", jobRef: "job" });
		expect(result.runs).toEqual([]);
	});

	it("reads only the local pool, never the live backend", async () => {
		const orchestrator = new Orchestrator();
		const backend = createStubCIBackend({ name: "gh" });
		orchestrator.addAdapter(backend);
		const runPool = createRunPool(openPipesDb(":memory:"));
		runPool.upsert({ backend: "gh", jobRef: "job", runId: "1", status: "success", result: "SUCCESS", url: "", startedAt: new Date(0), fetchedAt: new Date(0), watched: false });
		const service = createPipesService(orchestrator, { runPool });

		const result = await service.execute("ci.pool", { backend: "gh", jobRef: "job" });
		expect(result.runs).toHaveLength(1);
		expect(result.runs[0]?.status).toBe("success");
		expect(backend.calls.getRun).toHaveLength(0);
	});

	it("seeds the pool immediately on ci.trigger, before any background sync tick has run", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", capabilities: Capability.Trigger, triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "9" } }),
		);
		const runPool = createRunPool(openPipesDb(":memory:"));
		const service = createPipesService(orchestrator, { runPool });

		await service.execute("ci.trigger", { backend: "gh", jobRef: "job", params: {} });

		const seeded = runPool.get("gh", "job", "9");
		expect(seeded).toBeDefined();
		expect(seeded?.watched).toBe(true);
	});

	it("seeds one pool row per resolved step when triggering a named pipeline", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				capabilities: Capability.Trigger,
				run: { id: "1", name: "run", status: "success", startedAt: new Date(0) },
				triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "build", runId: "5" },
			}),
		);
		orchestrator.registerPipeline({ name: "deploy", backend: "gh", steps: [{ jobName: "build" }] });
		const runPool = createRunPool(openPipesDb(":memory:"));
		const service = createPipesService(orchestrator, { runPool });

		await service.execute("ci.trigger", { pipeline: "deploy" });

		expect(runPool.get("gh", "build", "5")).toBeDefined();
	});

	it("ci.trigger auto-subscribes the triggered job", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", capabilities: Capability.Trigger, triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "7" } }),
		);
		const runPool = createRunPool(openPipesDb(":memory:"));
		const service = createPipesService(orchestrator, { runPool });

		await service.execute("ci.trigger", { backend: "gh", jobRef: "job", params: {} });

		expect(runPool.isJobSubscribed("gh", "job")).toBe(true);
	});
});

describe("ci.subscribe / ci.unsubscribe", () => {
	it("throws a clear error when no run pool is configured", async () => {
		const service = createPipesService(new Orchestrator());
		await expect(service.execute("ci.subscribe", { backend: "gh", jobRef: "job" })).rejects.toThrow(/no local run pool/);
	});

	it("subscribes, does an immediate fetch, and returns the seeded snapshot", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", runsById: { latest: { id: "1", name: "job", status: "running", startedAt: new Date(0) } }, log: "hello" }));
		const runPool = createRunPool(openPipesDb(":memory:"));
		const service = createPipesService(orchestrator, { runPool });

		const result = await service.execute("ci.subscribe", { backend: "gh", jobRef: "job" });

		expect(result.subscribed).toBe(true);
		expect(result.run?.runId).toBe("1");
		expect(runPool.isJobSubscribed("gh", "job")).toBe(true);
		expect(runPool.getLog("gh", "job", "1")).toBe("hello");
	});

	it("still records the subscription even when the immediate fetch fails -- the next sync tick retries", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", err: new Error("not found yet") }));
		const runPool = createRunPool(openPipesDb(":memory:"));
		const service = createPipesService(orchestrator, { runPool });

		const result = await service.execute("ci.subscribe", { backend: "gh", jobRef: "job" });

		expect(result.subscribed).toBe(true);
		expect(result.run).toBeUndefined();
		expect(runPool.isJobSubscribed("gh", "job")).toBe(true);
	});

	it("immediately unsubscribes if the just-subscribed job's latest run is already terminal", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", runsById: { latest: { id: "1", name: "job", status: "success", startedAt: new Date(0) } } }));
		const runPool = createRunPool(openPipesDb(":memory:"));
		const service = createPipesService(orchestrator, { runPool });

		await service.execute("ci.subscribe", { backend: "gh", jobRef: "job" });

		expect(runPool.isJobSubscribed("gh", "job")).toBe(false);
	});

	it("ci.unsubscribe is idempotent and safe with no pool configured", async () => {
		const service = createPipesService(new Orchestrator());
		await expect(service.execute("ci.unsubscribe", { backend: "gh", jobRef: "job" })).resolves.toEqual({ unsubscribed: true });
	});

	it("ci.unsubscribe stops the job from being subscribed", async () => {
		const runPool = createRunPool(openPipesDb(":memory:"));
		runPool.subscribeJob("gh", "job");
		const service = createPipesService(new Orchestrator(), { runPool });

		await service.execute("ci.unsubscribe", { backend: "gh", jobRef: "job" });

		expect(runPool.isJobSubscribed("gh", "job")).toBe(false);
	});
});

describe("ci.tail", () => {
	it("reuses a cached log for a terminal run instead of hitting the live backend again", async () => {
		const orchestrator = new Orchestrator();
		const backend = createStubCIBackend({ name: "gh" });
		orchestrator.addAdapter(backend);
		const runPool = createRunPool(openPipesDb(":memory:"));
		runPool.upsert({ backend: "gh", jobRef: "job", runId: "1", status: "success", result: "SUCCESS", url: "", startedAt: new Date(0), fetchedAt: new Date(0), watched: false });
		runPool.upsertLog("gh", "job", "1", "cached log");
		const service = createPipesService(orchestrator, { runPool });

		const result = await service.execute("ci.tail", { backend: "gh", jobRef: "job", runId: "1" });

		expect(result.text).toBe("cached log");
		expect(backend.calls.getRun).toHaveLength(0);
	});

	it("always live-resolves when runId is omitted, matching the background sync's autofocus", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", runsById: { latest: { id: "2", name: "job", status: "running", startedAt: new Date(0) } }, log: "fresh log" }));
		const runPool = createRunPool(openPipesDb(":memory:"));
		// A stale cached run "1" exists, but a newer run "2" is now latest.
		runPool.upsert({ backend: "gh", jobRef: "job", runId: "1", status: "success", result: "", url: "", startedAt: new Date(0), fetchedAt: new Date(0), watched: false });
		runPool.upsertLog("gh", "job", "1", "stale log");
		const service = createPipesService(orchestrator, { runPool });

		const result = await service.execute("ci.tail", { backend: "gh", jobRef: "job" });

		expect(result.runId).toBe("2");
		expect(result.text).toBe("fresh log");
	});

	it("applies the token budget by default and reports truncation", async () => {
		const orchestrator = new Orchestrator();
		const longLog = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", runsById: { latest: { id: "1", name: "job", status: "success", startedAt: new Date(0) } }, log: longLog }));
		const service = createPipesService(orchestrator);

		const result = await service.execute("ci.tail", { backend: "gh", jobRef: "job", maxTokens: 50 });

		expect(result.truncated).toBe(true);
		expect(result.outputTokens).toBeLessThanOrEqual(50);
		expect(longLog.endsWith(result.text)).toBe(true);
	});

	it("works with no run pool configured at all -- always falls back to a live fetch", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", runsById: { latest: { id: "1", name: "job", status: "success", startedAt: new Date(0) } }, log: "no pool here" }));
		const service = createPipesService(orchestrator);

		const result = await service.execute("ci.tail", { backend: "gh", jobRef: "job" });

		expect(result.text).toBe("no pool here");
	});
});

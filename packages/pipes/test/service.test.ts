import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPipesDb } from "../src/db.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { Capability } from "../src/ports/ci-backend.ts";
import { loadPresets } from "../src/presets.ts";
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
			createStubCIBackend({
				name: "gh",
				capabilities: Capability.Trigger,
				run: { id: "1", name: "run", status: "success", startedAt: new Date(0) },
			}),
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
			createStubCIBackend({
				name: "gh",
				capabilities: Capability.Trigger,
				triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "7" },
			}),
		);
		const service = createPipesService(orchestrator);

		const result = await service.execute("ci.trigger", { backend: "gh", jobRef: "job", params: {} });
		expect(result.result?.buildNumber).toBe("7");
	});

	it("forwards params as a per-invocation override onto a pipeline's own baked-in step params", async () => {
		const orchestrator = new Orchestrator();
		const backend = createStubCIBackend({
			name: "gh",
			capabilities: Capability.Trigger,
			triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "1" },
			run: { id: "1", name: "run", status: "success", startedAt: new Date(0) },
		});
		orchestrator.addAdapter(backend);
		orchestrator.registerPipeline({ name: "deploy", backend: "gh", steps: [{ jobName: "build", params: { ENV: "stage" } }] });
		const service = createPipesService(orchestrator);

		await service.execute("ci.trigger", { pipeline: "deploy", params: { ENV: "prod" } });

		expect(backend.calls.trigger).toEqual([{ jobRef: "build", params: { ENV: "prod" } }]);
	});
});

describe("ci.wait", () => {
	it("resolves immediately once the watched run reaches a terminal status", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				capabilities: Capability.Trigger,
				run: { id: "1", name: "run", status: "success", startedAt: new Date(0) },
			}),
		);
		const service = createPipesService(orchestrator, { waitPollIntervalMs: 1 });

		const result = await service.execute("ci.wait", { backend: "gh", jobRef: "job", runId: "1", timeoutS: 5 });
		expect("status" in result && result.status).toBe("success");
	});

	it("polls until timeout and returns the last known status when the run never terminates", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				capabilities: Capability.Trigger,
				run: { id: "1", name: "run", status: "running", startedAt: new Date(0) },
			}),
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
			createStubCIBackend({
				name: "gh",
				capabilities: Capability.Trigger,
				resolvedReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "99" },
			}),
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
			createStubCIBackend({
				name: "gh",
				capabilities: Capability.Trigger,
				triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "7" },
			}),
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

describe("ci.discover", () => {
	it("lists repos when no repo is given", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				capabilities: Capability.Discover,
				repos: [{ name: "pipes", fullName: "DanyPops/pipes", private: false }],
			}),
		);
		const service = createPipesService(orchestrator);

		const result = await service.execute("ci.discover", { backend: "gh" });
		expect(result.repos).toEqual([{ name: "pipes", fullName: "DanyPops/pipes", private: false }]);
		expect(result.workflows).toBeUndefined();
	});

	it("lists workflows for that repo when repo is given", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				capabilities: Capability.Discover,
				workflows: [{ name: "CI", fileName: "ci.yml", state: "active" }],
			}),
		);
		const service = createPipesService(orchestrator);

		const result = await service.execute("ci.discover", { backend: "gh", repo: "pipes" });
		expect(result.workflows).toEqual([{ name: "CI", fileName: "ci.yml", state: "active" }]);
		expect(result.repos).toBeUndefined();
	});

	it("rejects with a 400-mappable CapabilityUnsupportedError against a backend without Discover", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "gitlab" }));
		const service = createPipesService(orchestrator);

		await expect(service.execute("ci.discover", { backend: "gitlab" })).rejects.toThrow(/discover/);
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
		runPool.upsert({
			backend: "gh",
			jobRef: "job",
			runId: "1",
			status: "success",
			result: "SUCCESS",
			url: "",
			startedAt: new Date(0),
			fetchedAt: new Date(0),
			watched: false,
		});
		const service = createPipesService(orchestrator, { runPool });

		const result = await service.execute("ci.pool", { backend: "gh", jobRef: "job" });
		expect(result.runs).toHaveLength(1);
		expect(result.runs[0]?.status).toBe("success");
		expect(backend.calls.getRun).toHaveLength(0);
	});

	it("seeds the pool immediately on ci.trigger, before any background sync tick has run", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				capabilities: Capability.Trigger,
				triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "9" },
			}),
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
			createStubCIBackend({
				name: "gh",
				capabilities: Capability.Trigger,
				triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "7" },
			}),
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
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				runsById: { latest: { id: "1", name: "job", status: "running", startedAt: new Date(0) } },
				log: "hello",
			}),
		);
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
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", runsById: { latest: { id: "1", name: "job", status: "success", startedAt: new Date(0) } } }),
		);
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
		runPool.upsert({
			backend: "gh",
			jobRef: "job",
			runId: "1",
			status: "success",
			result: "SUCCESS",
			url: "",
			startedAt: new Date(0),
			fetchedAt: new Date(0),
			watched: false,
		});
		runPool.upsertLog("gh", "job", "1", "cached log");
		const service = createPipesService(orchestrator, { runPool });

		const result = await service.execute("ci.tail", { backend: "gh", jobRef: "job", runId: "1" });

		expect(result.text).toBe("cached log");
		expect(backend.calls.getRun).toHaveLength(0);
	});

	it("always live-resolves when runId is omitted, matching the background sync's autofocus", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				runsById: { latest: { id: "2", name: "job", status: "running", startedAt: new Date(0) } },
				log: "fresh log",
			}),
		);
		const runPool = createRunPool(openPipesDb(":memory:"));
		// A stale cached run "1" exists, but a newer run "2" is now latest.
		runPool.upsert({
			backend: "gh",
			jobRef: "job",
			runId: "1",
			status: "success",
			result: "",
			url: "",
			startedAt: new Date(0),
			fetchedAt: new Date(0),
			watched: false,
		});
		runPool.upsertLog("gh", "job", "1", "stale log");
		const service = createPipesService(orchestrator, { runPool });

		const result = await service.execute("ci.tail", { backend: "gh", jobRef: "job" });

		expect(result.runId).toBe("2");
		expect(result.text).toBe("fresh log");
	});

	it("applies the token budget by default and reports truncation", async () => {
		const orchestrator = new Orchestrator();
		const longLog = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				runsById: { latest: { id: "1", name: "job", status: "success", startedAt: new Date(0) } },
				log: longLog,
			}),
		);
		const service = createPipesService(orchestrator);

		const result = await service.execute("ci.tail", { backend: "gh", jobRef: "job", maxTokens: 50 });

		expect(result.truncated).toBe(true);
		expect(result.outputTokens).toBeLessThanOrEqual(50);
		expect(longLog.endsWith(result.text)).toBe(true);
	});

	it("works with no run pool configured at all -- always falls back to a live fetch", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				runsById: { latest: { id: "1", name: "job", status: "success", startedAt: new Date(0) } },
				log: "no pool here",
			}),
		);
		const service = createPipesService(orchestrator);

		const result = await service.execute("ci.tail", { backend: "gh", jobRef: "job" });

		expect(result.text).toBe("no pool here");
	});

	it("carries the pooled run's URL through on a cached-terminal hit", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "gh" }));
		const runPool = createRunPool(openPipesDb(":memory:"));
		runPool.upsert({
			backend: "gh",
			jobRef: "job",
			runId: "1",
			status: "success",
			result: "SUCCESS",
			url: "https://ci.example/gh/job/1",
			startedAt: new Date(0),
			fetchedAt: new Date(0),
			watched: false,
		});
		runPool.upsertLog("gh", "job", "1", "cached log");
		const service = createPipesService(orchestrator, { runPool });

		const result = await service.execute("ci.tail", { backend: "gh", jobRef: "job", runId: "1" });

		expect(result.url).toBe("https://ci.example/gh/job/1");
	});

	it("carries the live-fetched run's URL through when there's no cache hit", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				runsById: { latest: { id: "1", name: "job", status: "success", startedAt: new Date(0), url: "https://ci.example/gh/job/1" } },
				log: "fresh log",
			}),
		);
		const service = createPipesService(orchestrator);

		const result = await service.execute("ci.tail", { backend: "gh", jobRef: "job" });

		expect(result.url).toBe("https://ci.example/gh/job/1");
	});
});

describe("ci.downstream", () => {
	it("delegates straight to the backend's own CIChainable lookup", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "jenkins",
				capabilities: Capability.Chain,
				downstreamRuns: [{ id: "10", name: "downstream", status: "success", startedAt: new Date(0) }],
			}),
		);
		const service = createPipesService(orchestrator);

		const result = await service.execute("ci.downstream", {
			backend: "jenkins",
			downstreamJob: "deploy",
			upstreamJob: "build",
			upstreamRunId: "5",
		});

		expect(result.runs).toHaveLength(1);
	});

	it("rejects a backend that doesn't support chain traversal", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "gh" }));
		const service = createPipesService(orchestrator);

		await expect(
			service.execute("ci.downstream", { backend: "gh", downstreamJob: "deploy", upstreamJob: "build", upstreamRunId: "5" }),
		).rejects.toThrow(/chain traversal/);
	});
});

describe("ci.presets.*: live CRUD, not just a static file read at boot", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("ci.presets.list starts empty when nothing is registered", async () => {
		const service = createPipesService(new Orchestrator());
		const result = await service.execute("ci.presets.list", {});
		expect(result.presets).toEqual([]);
	});

	it("ci.presets.set registers the preset in-memory immediately -- no restart needed to trigger it", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				capabilities: Capability.Trigger,
				triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "build", runId: "1" },
			}),
		);
		dir = mkdtempSync(join(tmpdir(), "pipes-service-presets-"));
		const presetsPath = join(dir, "pipelines.json");
		const service = createPipesService(orchestrator, { presetsPath });

		await service.execute("ci.presets.set", { preset: { name: "deploy", backend: "gh", steps: [{ jobName: "build" }] } });

		const run = await orchestrator.triggerPipeline("deploy");
		expect(run.status).toBe("success");
	});

	it("ci.presets.set persists to disk so a future daemon restart still sees it", async () => {
		const orchestrator = new Orchestrator();
		dir = mkdtempSync(join(tmpdir(), "pipes-service-presets-"));
		const presetsPath = join(dir, "pipelines.json");
		const service = createPipesService(orchestrator, { presetsPath });

		await service.execute("ci.presets.set", { preset: { name: "deploy", backend: "gh", steps: [{ jobName: "build" }] } });

		expect(loadPresets(presetsPath)).toEqual([{ name: "deploy", backend: "gh", steps: [{ jobName: "build" }] }]);
	});

	it("ci.presets.set upserts -- setting an existing name replaces it, in both list and on disk", async () => {
		const orchestrator = new Orchestrator();
		dir = mkdtempSync(join(tmpdir(), "pipes-service-presets-"));
		const presetsPath = join(dir, "pipelines.json");
		const service = createPipesService(orchestrator, { presetsPath });
		await service.execute("ci.presets.set", { preset: { name: "deploy", backend: "gh", steps: [{ jobName: "build" }] } });

		await service.execute("ci.presets.set", { preset: { name: "deploy", backend: "gitlab", steps: [{ jobName: "release" }] } });

		const listed = await service.execute("ci.presets.list", {});
		expect(listed.presets).toEqual([{ name: "deploy", backend: "gitlab", steps: [{ jobName: "release" }] }]);
		expect(loadPresets(presetsPath)).toEqual([{ name: "deploy", backend: "gitlab", steps: [{ jobName: "release" }] }]);
	});

	it("ci.presets.remove deletes an existing preset from memory and disk", async () => {
		const orchestrator = new Orchestrator();
		dir = mkdtempSync(join(tmpdir(), "pipes-service-presets-"));
		const presetsPath = join(dir, "pipelines.json");
		const service = createPipesService(orchestrator, { presetsPath });
		await service.execute("ci.presets.set", { preset: { name: "deploy", backend: "gh", steps: [{ jobName: "build" }] } });

		const result = await service.execute("ci.presets.remove", { name: "deploy" });

		expect(result.removed).toBe(true);
		expect((await service.execute("ci.presets.list", {})).presets).toEqual([]);
		expect(loadPresets(presetsPath)).toEqual([]);
	});

	it("ci.presets.remove is idempotent -- removing a name that was never registered reports removed:false without touching the file", async () => {
		const orchestrator = new Orchestrator();
		dir = mkdtempSync(join(tmpdir(), "pipes-service-presets-"));
		const presetsPath = join(dir, "pipelines.json");
		const service = createPipesService(orchestrator, { presetsPath });

		const result = await service.execute("ci.presets.remove", { name: "never-existed" });

		expect(result.removed).toBe(false);
		// No file was ever written -- loadPresets sees the "doesn't exist yet" default, not a write we never intended.
		expect(loadPresets(presetsPath)).toEqual([]);
	});
});

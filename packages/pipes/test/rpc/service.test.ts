import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findVehicleProject, registerVehicleProject } from "@danypops/vehicle-server/project-scope";
import { loadPresets } from "../../src/config/presets.ts";
import { Orchestrator } from "../../src/orchestrator.ts";
import { syncRunPool } from "../../src/process/pool-sync.ts";
import { createPipesService } from "../../src/rpc/service.ts";
import { Capability } from "../../src/run/ci-backend.ts";
import type { CIRun } from "../../src/run/ci-run.ts";
import { openPipesDb } from "../../src/sqlite/db.ts";
import { createRunPool, createSqliteVehicleProjectStore } from "../../src/sqlite/run-pool.ts";
import { createStubCIBackend } from "../fixtures/stub-ci-backend.ts";

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

	it("recovers a configured pipeline's status when a fresh daemon has no in-memory PipelineRun", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				runsById: { latest: { id: "42", name: "build", status: "success", startedAt: new Date(0) } },
			}),
		);
		orchestrator.registerPipeline({ name: "lector-ci", backend: "gh", steps: [{ jobName: "build" }] });
		const service = createPipesService(orchestrator);

		expect((await service.execute("ci.presets.list", {})).presets.map((preset) => preset.name)).toEqual(["lector-ci"]);
		const result = await service.execute("ci.status", { pipeline: "lector-ci" });

		expect(result.pipelineRun).toMatchObject({
			pipeline: "lector-ci",
			status: "success",
			steps: [{ jobName: "build", runId: "42", status: "success" }],
		});
	});

	it("keeps an actually unknown pipeline distinct from configured pipeline recovery", async () => {
		const service = createPipesService(new Orchestrator());
		await expect(service.execute("ci.status", { pipeline: "missing" })).rejects.toThrow(/pipeline not found: missing/);
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

	// Reproduces a real, observed gap: ci.subscribe already defaults subscriberId to
	// callContext.callerSessionId (see "defaults subscriberId to the caller's own real session id"
	// below), but ci.trigger's own auto-subscribe convenience path (seedPoolFromTrigger,
	// seedPoolFromPipelineRun) never got the same treatment -- handleTrigger isn't even given
	// callContext today. A live session that triggers a job never sees it in its own
	// ci.subscribed({subscriberId: <its own session id>}) view -- e.g. a Jobs widget -- even though
	// it's the very session that started the run, because the auto-subscription lands in the
	// anonymous "" bucket instead.
	it("attributes ci.trigger's own auto-subscription to the triggering session (callContext.callerSessionId), not the anonymous bucket", async () => {
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

		await service.execute("ci.trigger", { backend: "gh", jobRef: "job", params: {} }, { callerSessionId: "session-42" });

		expect(runPool.isJobSubscribed("gh", "job", "session-42")).toBe(true);
		expect(runPool.isJobSubscribed("gh", "job", "")).toBe(false);
		expect(runPool.watchedRunsWithProjectLabels("session-42").some((run) => run.jobRef === "job")).toBe(true);
	});

	// Same gap, pipeline-trigger flavor: seedPoolFromPipelineRun seeds one row per resolved step,
	// also always into the anonymous bucket regardless of who triggered the pipeline.
	it("attributes a pipeline trigger's own auto-subscription (each step) to the triggering session too", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				capabilities: Capability.Trigger,
				// Deliberately "running", not "success" -- a terminal status would immediately
				// self-unsubscribe right after the auto-subscribe this test is trying to observe.
				run: { id: "1", name: "run", status: "running", startedAt: new Date(0) },
				triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "build", runId: "5" },
			}),
		);
		orchestrator.registerPipeline({ name: "deploy", backend: "gh", steps: [{ jobName: "build" }] });
		const runPool = createRunPool(openPipesDb(":memory:"));
		const service = createPipesService(orchestrator, { runPool });

		await service.execute("ci.trigger", { pipeline: "deploy" }, { callerSessionId: "session-42" });

		expect(runPool.isJobSubscribed("gh", "build", "session-42")).toBe(true);
		expect(runPool.isJobSubscribed("gh", "build", "")).toBe(false);
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
		expect(result.truncated).toBe(false);
	});

	it("surfaces truncated:true from the backend instead of silently dropping it", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", searchResults: [], searchTruncated: true }));
		const service = createPipesService(orchestrator);

		const result = await service.execute("ci.search", { backend: "gh", jobRef: "job" });
		expect(result.truncated).toBe(true);
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

	it("ci.trigger's auto-subscribe pins to the exact run id it just produced, not 'latest' -- immune to another unrelated concurrent trigger on the same job", async () => {
		const orchestrator = new Orchestrator();
		const runsById: Record<string, CIRun> = {
			"7": { id: "7", name: "job", status: "running", startedAt: new Date(0) },
			latest: { id: "7", name: "job", status: "running", startedAt: new Date(0) },
		};
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				capabilities: Capability.Trigger,
				triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "7" },
				runsById,
			}),
		);
		const runPool = createRunPool(openPipesDb(":memory:"));
		const service = createPipesService(orchestrator, { runPool });

		await service.execute("ci.trigger", { backend: "gh", jobRef: "job", params: {} });
		expect(runPool.watchedSubscriptions().find((s) => s.subscriberId === "")?.pinnedRunId).toBe("7");

		// Someone else's unrelated build ("8") supersedes "latest" on this shared job.
		runsById.latest = { id: "8", name: "job", status: "running", startedAt: new Date(0) };
		await syncRunPool(orchestrator, runPool);

		expect(runPool.get("gh", "job", "7")).toBeDefined();
		expect(runPool.get("gh", "job", "8")).toBeUndefined();
	});

	it("a pipeline trigger's auto-subscribe also pins each step to its own produced run id, not 'latest'", async () => {
		const orchestrator = new Orchestrator();
		const runsById: Record<string, CIRun> = {
			"5": { id: "5", name: "run", status: "running", startedAt: new Date(0) },
			latest: { id: "5", name: "run", status: "running", startedAt: new Date(0) },
		};
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				capabilities: Capability.Trigger,
				triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "build", runId: "5" },
				runsById,
			}),
		);
		orchestrator.registerPipeline({ name: "deploy", backend: "gh", steps: [{ jobName: "build" }] });
		const runPool = createRunPool(openPipesDb(":memory:"));
		const service = createPipesService(orchestrator, { runPool });

		await service.execute("ci.trigger", { pipeline: "deploy" });
		expect(runPool.watchedSubscriptions().find((s) => s.jobRef === "build")?.pinnedRunId).toBe("5");

		// Someone else's unrelated build ("6") supersedes "latest" on this shared job.
		runsById.latest = { id: "6", name: "run", status: "running", startedAt: new Date(0) };
		await syncRunPool(orchestrator, runPool);

		expect(runPool.get("gh", "build", "5")).toBeDefined();
		expect(runPool.get("gh", "build", "6")).toBeUndefined();
	});
});

describe("ci.subscribed", () => {
	it("returns an empty list when no run pool is configured, rather than throwing", async () => {
		const service = createPipesService(new Orchestrator());
		const result = await service.execute("ci.subscribed", {});
		expect(result.runs).toEqual([]);
	});

	it("returns every currently-watched run across every backend/jobRef, not scoped to one job like ci.pool", async () => {
		const runPool = createRunPool(openPipesDb(":memory:"));
		runPool.upsert({
			backend: "gh",
			jobRef: "job-a",
			runId: "1",
			status: "running",
			result: "",
			url: "",
			startedAt: new Date(0),
			fetchedAt: new Date(0),
			watched: true,
		});
		runPool.upsert({
			backend: "jenkins",
			jobRef: "job-b",
			runId: "2",
			status: "running",
			result: "",
			url: "",
			startedAt: new Date(0),
			fetchedAt: new Date(0),
			watched: true,
		});
		// A terminal, no-longer-watched run must not appear -- watchedRuns() is the whole point.
		runPool.upsert({
			backend: "gh",
			jobRef: "job-c",
			runId: "3",
			status: "success",
			result: "SUCCESS",
			url: "",
			startedAt: new Date(0),
			fetchedAt: new Date(0),
			watched: false,
		});
		const service = createPipesService(new Orchestrator(), { runPool });

		const result = await service.execute("ci.subscribed", {});

		expect(result.runs.map((r) => r.runId).sort()).toEqual(["1", "2"]);
	});

	it("an explicit subscriberId scopes the result to only that caller's own subscribed jobs -- the cross-session leak fix", async () => {
		const runPool = createRunPool(openPipesDb(":memory:"));
		runPool.subscribeJob("jenkins", "deploy-a", { subscriberId: "session-a" });
		runPool.subscribeJob("gh", "build-b", { subscriberId: "session-b" });
		runPool.upsert({
			backend: "jenkins",
			jobRef: "deploy-a",
			runId: "1",
			status: "running",
			result: "",
			url: "",
			startedAt: new Date(0),
			fetchedAt: new Date(0),
			watched: true,
		});
		runPool.upsert({
			backend: "gh",
			jobRef: "build-b",
			runId: "2",
			status: "running",
			result: "",
			url: "",
			startedAt: new Date(0),
			fetchedAt: new Date(0),
			watched: true,
		});
		const service = createPipesService(new Orchestrator(), { runPool });

		const forA = await service.execute("ci.subscribed", { subscriberId: "session-a" });
		expect(forA.runs.map((r) => r.jobRef)).toEqual(["deploy-a"]);

		const forB = await service.execute("ci.subscribed", { subscriberId: "session-b" });
		expect(forB.runs.map((r) => r.jobRef)).toEqual(["build-b"]);

		const unscoped = await service.execute("ci.subscribed", {});
		expect(unscoped.runs.map((r) => r.jobRef).sort()).toEqual(["build-b", "deploy-a"]);
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

	it("ci.unsubscribe also clears run_snapshots.watched, so ci.subscribed stops listing it immediately -- not just job_watches", async () => {
		// Reproduces task 8a0cec61-a033-4e83-bd58-1f2ed3cb5215: ci.subscribed / watchedRunsWithProjectLabels()
		// reads run_snapshots.watched, an entirely separate store from job_watches -- unsubscribeJob() only
		// ever touched the latter, so a run stayed listed as watched forever after an explicit unsubscribe,
		// since nothing was left polling it to ever correct the stale flag.
		const runPool = createRunPool(openPipesDb(":memory:"));
		runPool.subscribeJob("gh", "job");
		runPool.upsert({
			backend: "gh",
			jobRef: "job",
			runId: "1",
			status: "running",
			result: "",
			url: "",
			startedAt: new Date(0),
			fetchedAt: new Date(0),
			watched: true,
		});
		const service = createPipesService(new Orchestrator(), { runPool });

		await service.execute("ci.unsubscribe", { backend: "gh", jobRef: "job" });

		const result = await service.execute("ci.subscribed", {});
		expect(result.runs).toEqual([]);
	});

	it("ci.subscribe accepts an optional subscriberId + scheduleMs, tracked independently from the default anonymous subscriber", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				runsById: { latest: { id: "1", name: "job", status: "running", startedAt: new Date(0) } },
			}),
		);
		const runPool = createRunPool(openPipesDb(":memory:"));
		const service = createPipesService(orchestrator, { runPool });

		await service.execute("ci.subscribe", { backend: "gh", jobRef: "job", subscriberId: "alice", scheduleMs: 60_000 });
		await service.execute("ci.subscribe", { backend: "gh", jobRef: "job" });

		const subs = runPool.watchedSubscriptions();
		expect(subs.find((s) => s.subscriberId === "alice")?.scheduleMs).toBe(60_000);
		expect(subs.find((s) => s.subscriberId === "")).toBeDefined();
		expect(subs).toHaveLength(2);
	});

	it("ci.unsubscribe with a subscriberId removes only that subscriber, leaving the default subscriber's watch intact", async () => {
		const runPool = createRunPool(openPipesDb(":memory:"));
		runPool.subscribeJob("gh", "job", { subscriberId: "alice" });
		runPool.subscribeJob("gh", "job");
		const service = createPipesService(new Orchestrator(), { runPool });

		await service.execute("ci.unsubscribe", { backend: "gh", jobRef: "job", subscriberId: "alice" });

		expect(runPool.isJobSubscribed("gh", "job", "alice")).toBe(false);
		expect(runPool.isJobSubscribed("gh", "job")).toBe(true);
	});

	it("ci.subscribe with a runId pins the watch and returns that exact run's status, even when a different 'latest' exists", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "jenkins",
				runsById: {
					"9191": { id: "9191", name: "job", status: "running", startedAt: new Date(0) },
					latest: { id: "9193", name: "job", status: "success", startedAt: new Date(0) },
				},
			}),
		);
		const runPool = createRunPool(openPipesDb(":memory:"));
		const service = createPipesService(orchestrator, { runPool });

		const result = await service.execute("ci.subscribe", { backend: "jenkins", jobRef: "job", runId: "9191" });

		expect(result.run?.runId).toBe("9191");
		expect(result.run?.status).toBe("running");
		expect(runPool.watchedSubscriptions().find((s) => s.subscriberId === "")?.pinnedRunId).toBe("9191");
	});

	it("ci.subscribe with a runId that's already terminal on the very first fetch unsubscribes just that subscription, not the whole job", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "jenkins",
				runsById: {
					"9191": { id: "9191", name: "job", status: "success", startedAt: new Date(0) },
					latest: { id: "9193", name: "job", status: "running", startedAt: new Date(0) },
				},
			}),
		);
		const runPool = createRunPool(openPipesDb(":memory:"));
		runPool.subscribeJob("jenkins", "job", { subscriberId: "bob" });
		const service = createPipesService(orchestrator, { runPool });

		await service.execute("ci.subscribe", { backend: "jenkins", jobRef: "job", subscriberId: "alice", runId: "9191" });

		expect(runPool.isJobSubscribed("jenkins", "job", "alice")).toBe(false);
		expect(runPool.isJobSubscribed("jenkins", "job", "bob")).toBe(true);
	});

	it("defaults subscriberId to the caller's own real session id (callContext.callerSessionId) instead of the shared anonymous subscriber, when the caller doesn't pass one explicitly", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", runsById: { latest: { id: "1", name: "job", status: "running", startedAt: new Date(0) } } }),
		);
		const runPool = createRunPool(openPipesDb(":memory:"));
		const service = createPipesService(orchestrator, { runPool });

		await service.execute("ci.subscribe", { backend: "gh", jobRef: "job" }, { callerSessionId: "session-42" });

		expect(runPool.isJobSubscribed("gh", "job", "session-42")).toBe(true);
		expect(runPool.isJobSubscribed("gh", "job", "")).toBe(false);
	});

	it("an explicit subscriberId still wins over callContext.callerSessionId", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", runsById: { latest: { id: "1", name: "job", status: "running", startedAt: new Date(0) } } }),
		);
		const runPool = createRunPool(openPipesDb(":memory:"));
		const service = createPipesService(orchestrator, { runPool });

		await service.execute("ci.subscribe", { backend: "gh", jobRef: "job", subscriberId: "alice" }, { callerSessionId: "session-42" });

		expect(runPool.isJobSubscribed("gh", "job", "alice")).toBe(true);
		expect(runPool.isJobSubscribed("gh", "job", "session-42")).toBe(false);
	});

	it("auto-registers and records the caller's own project root (callContext.callerProjectRoot) on the subscription", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", runsById: { latest: { id: "1", name: "job", status: "running", startedAt: new Date(0) } } }),
		);
		const db = openPipesDb(":memory:");
		const runPool = createRunPool(db);
		const projectStore = createSqliteVehicleProjectStore(db);
		const service = createPipesService(orchestrator, { runPool, projectStore });

		await service.execute("ci.subscribe", { backend: "gh", jobRef: "job" }, { callerProjectRoot: "/home/x/pipes" });

		expect(runPool.watchedSubscriptions()[0]?.projectRoot).toBe("/home/x/pipes");
		expect(findVehicleProject(projectStore, "/home/x/pipes")?.name).toBe("pipes");
	});

	it("an explicit projectRoot input still wins over callContext.callerProjectRoot", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", runsById: { latest: { id: "1", name: "job", status: "running", startedAt: new Date(0) } } }),
		);
		const runPool = createRunPool(openPipesDb(":memory:"));
		const service = createPipesService(orchestrator, { runPool });

		await service.execute(
			"ci.subscribe",
			{ backend: "gh", jobRef: "job", projectRoot: "/home/x/explicit" },
			{ callerProjectRoot: "/home/x/from-context" },
		);

		expect(runPool.watchedSubscriptions()[0]?.projectRoot).toBe("/home/x/explicit");
	});

	it("never throws when no projectStore is configured, even with a callerProjectRoot present -- registration is best-effort", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", runsById: { latest: { id: "1", name: "job", status: "running", startedAt: new Date(0) } } }),
		);
		const runPool = createRunPool(openPipesDb(":memory:"));
		const service = createPipesService(orchestrator, { runPool });

		await expect(
			service.execute("ci.subscribe", { backend: "gh", jobRef: "job" }, { callerProjectRoot: "/home/x/pipes" }),
		).resolves.toBeDefined();
		expect(runPool.watchedSubscriptions()[0]?.projectRoot).toBe("/home/x/pipes");
	});
});

describe("ci.subscribed: project labels", () => {
	it("attaches the subscribing project's own name to each watched run", async () => {
		const db = openPipesDb(":memory:");
		const runPool = createRunPool(db);
		const projectStore = createSqliteVehicleProjectStore(db);
		registerVehicleProject(projectStore, { projectRoot: "/home/x/pipes" });
		runPool.subscribeJob("gh", "job", { projectRoot: "/home/x/pipes" });
		runPool.upsert({
			backend: "gh",
			jobRef: "job",
			runId: "1",
			status: "running",
			result: "",
			url: "",
			startedAt: new Date(0),
			fetchedAt: new Date(0),
			watched: true,
		});
		const service = createPipesService(new Orchestrator(), { runPool, projectStore });

		const result = await service.execute("ci.subscribed", {});

		expect(result.runs[0]?.projectRoot).toBe("/home/x/pipes");
		expect(result.runs[0]?.projectName).toBe("pipes");
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

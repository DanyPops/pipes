import { describe, expect, it } from "bun:test";
import { Orchestrator } from "../../src/orchestrator.ts";
import { syncRunPool } from "../../src/process/pool-sync.ts";
import type { CIRun } from "../../src/run/ci-run.ts";
import { openPipesDb } from "../../src/sqlite/db.ts";
import { createRunPool } from "../../src/sqlite/run-pool.ts";
import { createStubCIBackend } from "../fixtures/stub-ci-backend.ts";

describe("syncRunPool", () => {
	it("resolves a watched job's latest run and caches its status and full log", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				runsById: { latest: { id: "1", name: "job", status: "success", startedAt: new Date(0) } },
				log: "full log text",
			}),
		);
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("gh", "job");

		await syncRunPool(orchestrator, pool);

		expect(pool.get("gh", "job", "1")?.status).toBe("success");
		expect(pool.getLog("gh", "job", "1")).toBe("full log text");
	});

	it("autofocuses on a new run superseding the last one observed, since it always re-resolves latest", async () => {
		const orchestrator = new Orchestrator();
		const runsById: Record<string, CIRun> = { latest: { id: "1", name: "job", status: "running", startedAt: new Date(0) } };
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", runsById }));
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("gh", "job");

		await syncRunPool(orchestrator, pool);
		expect(pool.get("gh", "job", "1")).toBeDefined();

		// A new run (id "2") supersedes the old one -- getRun("latest") now resolves to it.
		runsById.latest = { id: "2", name: "job", status: "running", startedAt: new Date(0) };
		await syncRunPool(orchestrator, pool);

		expect(pool.get("gh", "job", "2")).toBeDefined();
	});

	it("auto-unsubscribes the job once its latest run reaches a terminal status", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", runsById: { latest: { id: "1", name: "job", status: "failure", startedAt: new Date(0) } } }),
		);
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("gh", "job");

		await syncRunPool(orchestrator, pool);

		expect(pool.isJobSubscribed("gh", "job")).toBe(false);
		expect(pool.watchedJobs()).toHaveLength(0);
		expect(pool.get("gh", "job", "1")?.status).toBe("failure"); // the last snapshot is kept even after unsubscribing
	});

	it("keeps the job subscribed while its latest run is still running or pending", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", runsById: { latest: { id: "1", name: "job", status: "running", startedAt: new Date(0) } } }),
		);
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("gh", "job");

		await syncRunPool(orchestrator, pool);

		expect(pool.isJobSubscribed("gh", "job")).toBe(true);
	});

	it("isolates one job's refresh failure from the rest of the batch", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "broken", err: new Error("backend unreachable") }));
		orchestrator.addAdapter(
			createStubCIBackend({ name: "ok", runsById: { latest: { id: "2", name: "job", status: "success", startedAt: new Date(0) } } }),
		);
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("broken", "job");
		pool.subscribeJob("ok", "job");

		await expect(syncRunPool(orchestrator, pool)).resolves.toBeUndefined();

		expect(pool.isJobSubscribed("broken", "job")).toBe(true); // refresh failed, still subscribed, will retry next tick
		expect(pool.get("ok", "job", "2")?.status).toBe("success");
	});

	it("does nothing when no jobs are watched", async () => {
		const orchestrator = new Orchestrator();
		const pool = createRunPool(openPipesDb(":memory:"));
		await expect(syncRunPool(orchestrator, pool)).resolves.toBeUndefined();
	});

	it("skips a subscription whose schedule hasn't come due yet -- no adapter call at all on that tick", async () => {
		const orchestrator = new Orchestrator();
		const backend = createStubCIBackend({
			name: "gh",
			runsById: { latest: { id: "1", name: "job", status: "running", startedAt: new Date(0) } },
		});
		orchestrator.addAdapter(backend);
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("gh", "job", { subscriberId: "alice", scheduleMs: 60_000 });

		await syncRunPool(orchestrator, pool, undefined, undefined, () => 0);
		expect(backend.calls.getRun).toHaveLength(1);

		// Not due yet -- only 30s have passed against a 60s schedule.
		await syncRunPool(orchestrator, pool, undefined, undefined, () => 30_000);
		expect(backend.calls.getRun).toHaveLength(1);

		// Due now -- 61s have passed.
		await syncRunPool(orchestrator, pool, undefined, undefined, () => 61_000);
		expect(backend.calls.getRun).toHaveLength(2);
	});

	it("a subscription with no scheduleMs is checked on every tick regardless of now()", async () => {
		const orchestrator = new Orchestrator();
		const runsById: Record<string, CIRun> = { latest: { id: "1", name: "job", status: "running", startedAt: new Date(0) } };
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", runsById }));
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("gh", "job");

		await syncRunPool(orchestrator, pool, undefined, undefined, () => 0);
		runsById.latest = { id: "2", name: "job", status: "running", startedAt: new Date(0) };
		await syncRunPool(orchestrator, pool, undefined, undefined, () => 1);

		expect(pool.get("gh", "job", "2")).toBeDefined();
	});

	it("a job is checked if ANY of its subscribers is due, and every attached subscriber's lastCheckedAt is refreshed together", async () => {
		const orchestrator = new Orchestrator();
		const backend = createStubCIBackend({
			name: "gh",
			runsById: { latest: { id: "1", name: "job", status: "running", startedAt: new Date(0) } },
		});
		orchestrator.addAdapter(backend);
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("gh", "job", { subscriberId: "alice", scheduleMs: 5_000 });
		pool.subscribeJob("gh", "job", { subscriberId: "bob", scheduleMs: 60_000 });

		await syncRunPool(orchestrator, pool, undefined, undefined, () => 0);
		// alice's 5s schedule is due at t=6000, bob's 60s schedule is not -- the job is still fetched exactly once, for both.
		await syncRunPool(orchestrator, pool, undefined, undefined, () => 6_000);

		expect(backend.calls.getRun).toHaveLength(2);
		const subs = pool.watchedSubscriptions();
		expect(subs.find((s) => s.subscriberId === "alice")?.lastCheckedAt?.getTime()).toBe(6_000);
		expect(subs.find((s) => s.subscriberId === "bob")?.lastCheckedAt?.getTime()).toBe(6_000);
	});

	it("auto-unsubscribes every subscriber on the job once its latest run reaches a terminal status, not just one", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", runsById: { latest: { id: "1", name: "job", status: "failure", startedAt: new Date(0) } } }),
		);
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("gh", "job", { subscriberId: "alice" });
		pool.subscribeJob("gh", "job", { subscriberId: "bob" });

		await syncRunPool(orchestrator, pool);

		expect(pool.isJobSubscribed("gh", "job", "alice")).toBe(false);
		expect(pool.isJobSubscribed("gh", "job", "bob")).toBe(false);
		expect(pool.watchedJobs()).toHaveLength(0);
	});

	it("calls onStatusChange when a run's status differs from what the pool had previously recorded for it", async () => {
		const orchestrator = new Orchestrator();
		const runsById: Record<string, CIRun> = { latest: { id: "1", name: "job", status: "running", startedAt: new Date(0) } };
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", runsById }));
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("gh", "job");

		const transitions: unknown[] = [];
		await syncRunPool(orchestrator, pool, undefined, (t) => transitions.push(t));
		expect(transitions).toEqual([{ backend: "gh", jobRef: "job", runId: "1", status: "running", url: "" }]);

		runsById.latest = { id: "1", name: "job", status: "success", startedAt: new Date(0) };
		await syncRunPool(orchestrator, pool, undefined, (t) => transitions.push(t));
		expect(transitions).toHaveLength(2);
		expect(transitions[1]).toEqual({ backend: "gh", jobRef: "job", runId: "1", status: "success", url: "" });
	});

	it("does not call onStatusChange when a tick re-fetches the exact same status", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", runsById: { latest: { id: "1", name: "job", status: "running", startedAt: new Date(0) } } }),
		);
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("gh", "job");

		const transitions: unknown[] = [];
		await syncRunPool(orchestrator, pool, undefined, (t) => transitions.push(t));
		await syncRunPool(orchestrator, pool, undefined, (t) => transitions.push(t));

		expect(transitions).toHaveLength(1);
	});
});

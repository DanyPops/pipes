import { describe, expect, it } from "bun:test";
import { openPipesDb } from "../src/db.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { syncRunPool } from "../src/pool-sync.ts";
import { createRunPool } from "../src/run-pool.ts";
import { createStubCIBackend } from "./fixtures/stub-ci-backend.ts";

describe("syncRunPool", () => {
	it("refreshes a watched run's status through the real orchestrator/adapter path", async () => {
		const orchestrator = new Orchestrator();
		const backendOptions = { name: "gh", run: { id: "1", name: "job", status: "success" as const, startedAt: new Date(0) } };
		orchestrator.addAdapter(createStubCIBackend(backendOptions));
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.upsert({ backend: "gh", jobRef: "job", runId: "1", status: "running", result: "", url: "", startedAt: new Date(0), fetchedAt: new Date(0), watched: true });

		await syncRunPool(orchestrator, pool);

		expect(pool.get("gh", "job", "1")?.status).toBe("success");
	});

	it("clears the watched flag once a run reaches a terminal status", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", run: { id: "1", name: "job", status: "failure", startedAt: new Date(0) } }));
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.upsert({ backend: "gh", jobRef: "job", runId: "1", status: "running", result: "", url: "", startedAt: new Date(0), fetchedAt: new Date(0), watched: true });

		await syncRunPool(orchestrator, pool);

		expect(pool.get("gh", "job", "1")?.watched).toBe(false);
		expect(pool.watchedRuns()).toHaveLength(0);
	});

	it("keeps watched=true while the run is still running or pending", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", run: { id: "1", name: "job", status: "running", startedAt: new Date(0) } }));
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.upsert({ backend: "gh", jobRef: "job", runId: "1", status: "pending", result: "", url: "", startedAt: new Date(0), fetchedAt: new Date(0), watched: true });

		await syncRunPool(orchestrator, pool);

		expect(pool.get("gh", "job", "1")?.watched).toBe(true);
	});

	it("isolates one run's refresh failure from the rest of the batch", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "broken", err: new Error("backend unreachable") }));
		orchestrator.addAdapter(createStubCIBackend({ name: "ok", run: { id: "2", name: "job", status: "success", startedAt: new Date(0) } }));
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.upsert({ backend: "broken", jobRef: "job", runId: "1", status: "running", result: "", url: "", startedAt: new Date(0), fetchedAt: new Date(0), watched: true });
		pool.upsert({ backend: "ok", jobRef: "job", runId: "2", status: "running", result: "", url: "", startedAt: new Date(0), fetchedAt: new Date(0), watched: true });

		await expect(syncRunPool(orchestrator, pool)).resolves.toBeUndefined();

		expect(pool.get("broken", "job", "1")?.status).toBe("running"); // unchanged: refresh failed, old snapshot kept
		expect(pool.get("ok", "job", "2")?.status).toBe("success");
	});

	it("does nothing when no runs are watched", async () => {
		const orchestrator = new Orchestrator();
		const pool = createRunPool(openPipesDb(":memory:"));
		await expect(syncRunPool(orchestrator, pool)).resolves.toBeUndefined();
	});
});

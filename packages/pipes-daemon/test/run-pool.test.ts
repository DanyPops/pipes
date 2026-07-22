import { describe, expect, it } from "bun:test";
import { openPipesDb } from "../src/db.ts";
import { createRunPool, isTerminalStatus, type RunSnapshot } from "../src/run-pool.ts";

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		backend: "gh",
		jobRef: "job",
		runId: "1",
		status: "running",
		result: "",
		url: "https://example.test/1",
		startedAt: new Date(1000),
		fetchedAt: new Date(2000),
		watched: true,
		...overrides,
	};
}

describe("isTerminalStatus", () => {
	it("classifies success/failure/aborted/not_found as terminal, pending/running as not", () => {
		expect(isTerminalStatus("success")).toBe(true);
		expect(isTerminalStatus("failure")).toBe(true);
		expect(isTerminalStatus("aborted")).toBe(true);
		expect(isTerminalStatus("not_found")).toBe(true);
		expect(isTerminalStatus("pending")).toBe(false);
		expect(isTerminalStatus("running")).toBe(false);
	});
});

describe("createRunPool", () => {
	it("round-trips a snapshot through upsert/get", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.upsert(snapshot());
		const got = pool.get("gh", "job", "1");
		expect(got?.status).toBe("running");
		expect(got?.url).toBe("https://example.test/1");
		expect(got?.startedAt.getTime()).toBe(1000);
	});

	it("returns undefined for a run that was never seen", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		expect(pool.get("gh", "job", "999")).toBeUndefined();
	});

	it("upsert overwrites the same (backend, jobRef, runId) row rather than duplicating it", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.upsert(snapshot({ status: "running", watched: true }));
		pool.upsert(snapshot({ status: "success", watched: false, fetchedAt: new Date(3000) }));

		const got = pool.get("gh", "job", "1");
		expect(got?.status).toBe("success");
		expect(got?.watched).toBe(false);
		expect(pool.recent("gh", "job", 10)).toHaveLength(1);
	});

	it("recent returns rows newest-fetched-first and respects the limit", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.upsert(snapshot({ runId: "1", fetchedAt: new Date(1000) }));
		pool.upsert(snapshot({ runId: "2", fetchedAt: new Date(3000) }));
		pool.upsert(snapshot({ runId: "3", fetchedAt: new Date(2000) }));

		const recent = pool.recent("gh", "job", 2);
		expect(recent.map((r) => r.runId)).toEqual(["2", "3"]);
	});

	it("recent is scoped to the given backend and jobRef, not the whole table", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.upsert(snapshot({ backend: "gh", jobRef: "a", runId: "1" }));
		pool.upsert(snapshot({ backend: "gh", jobRef: "b", runId: "1" }));
		pool.upsert(snapshot({ backend: "gl", jobRef: "a", runId: "1" }));

		expect(pool.recent("gh", "a", 10)).toHaveLength(1);
	});

	it("watchedRuns returns only rows currently flagged watched", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.upsert(snapshot({ runId: "1", watched: true }));
		pool.upsert(snapshot({ runId: "2", watched: false }));

		const watched = pool.watchedRuns();
		expect(watched.map((r) => r.runId)).toEqual(["1"]);
	});
});

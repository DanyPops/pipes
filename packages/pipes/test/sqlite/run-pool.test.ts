import { describe, expect, it } from "bun:test";
import { openPipesDb } from "../../src/sqlite/db.ts";
import { createRunPool, isTerminalStatus, type RunSnapshot } from "../../src/sqlite/run-pool.ts";

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

describe("createRunPool: log cache", () => {
	it("getLog returns undefined for a run with no status row at all, but '' for one whose log hasn't been fetched yet", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		expect(pool.getLog("gh", "job", "1")).toBeUndefined();

		pool.upsert(snapshot());
		expect(pool.getLog("gh", "job", "1")).toBe("");

		pool.upsertLog("gh", "job", "1", "line one\nline two");
		expect(pool.getLog("gh", "job", "1")).toBe("line one\nline two");
	});

	it("upsertLog overwrites rather than appends", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.upsert(snapshot());
		pool.upsertLog("gh", "job", "1", "first");
		pool.upsertLog("gh", "job", "1", "second");
		expect(pool.getLog("gh", "job", "1")).toBe("second");
	});

	it("log is scoped to the exact (backend, jobRef, runId), not shared across runs", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.upsert(snapshot({ runId: "1" }));
		pool.upsert(snapshot({ runId: "2" }));
		pool.upsertLog("gh", "job", "1", "run one's log");

		expect(pool.getLog("gh", "job", "1")).toBe("run one's log");
		expect(pool.getLog("gh", "job", "2")).toBe("");
	});
});

describe("createRunPool: job-level subscriptions", () => {
	it("subscribeJob then isJobSubscribed/watchedJobs reflect it", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		expect(pool.isJobSubscribed("gh", "job")).toBe(false);

		pool.subscribeJob("gh", "job");
		expect(pool.isJobSubscribed("gh", "job")).toBe(true);
		expect(pool.watchedJobs()).toEqual([{ backend: "gh", jobRef: "job" }]);
	});

	it("subscribeJob is idempotent", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("gh", "job");
		pool.subscribeJob("gh", "job");
		expect(pool.watchedJobs()).toHaveLength(1);
	});

	it("unsubscribeJob is idempotent for an already-absent subscription", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		expect(() => pool.unsubscribeJob("gh", "job")).not.toThrow();

		pool.subscribeJob("gh", "job");
		pool.unsubscribeJob("gh", "job");
		pool.unsubscribeJob("gh", "job");
		expect(pool.isJobSubscribed("gh", "job")).toBe(false);
	});

	it("subscriptions are scoped per (backend, jobRef)", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("gh", "a");
		expect(pool.isJobSubscribed("gh", "b")).toBe(false);
		expect(pool.isJobSubscribed("gl", "a")).toBe(false);
	});
});

describe("createRunPool: per-subscriber subscriptions", () => {
	it("two different subscriberIds watching the same job are independent rows in watchedSubscriptions()", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("gh", "job", { subscriberId: "alice", scheduleMs: 60_000 });
		pool.subscribeJob("gh", "job", { subscriberId: "bob", scheduleMs: 5_000 });

		const subs = pool.watchedSubscriptions();
		expect(subs).toHaveLength(2);
		expect(subs.find((s) => s.subscriberId === "alice")?.scheduleMs).toBe(60_000);
		expect(subs.find((s) => s.subscriberId === "bob")?.scheduleMs).toBe(5_000);
	});

	it("watchedJobs() dedupes across subscribers -- one entry per (backend, jobRef) regardless of subscriber count", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("gh", "job", { subscriberId: "alice" });
		pool.subscribeJob("gh", "job", { subscriberId: "bob" });

		expect(pool.watchedJobs()).toEqual([{ backend: "gh", jobRef: "job" }]);
	});

	it("unsubscribing one subscriberId leaves another subscriber's watch on the same job intact", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("gh", "job", { subscriberId: "alice" });
		pool.subscribeJob("gh", "job", { subscriberId: "bob" });

		pool.unsubscribeJob("gh", "job", "alice");

		expect(pool.isJobSubscribed("gh", "job", "alice")).toBe(false);
		expect(pool.isJobSubscribed("gh", "job", "bob")).toBe(true);
		expect(pool.watchedJobs()).toEqual([{ backend: "gh", jobRef: "job" }]);
	});

	it("unsubscribeAllForJob removes every subscriber watching that job in one call", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("gh", "job", { subscriberId: "alice" });
		pool.subscribeJob("gh", "job", { subscriberId: "bob" });

		pool.unsubscribeAllForJob("gh", "job");

		expect(pool.watchedJobs()).toEqual([]);
		expect(pool.watchedSubscriptions()).toEqual([]);
	});

	it("subscribeJob defaults subscriberId to '' -- the same anonymous subscriber every pre-existing caller implicitly uses", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("gh", "job");

		expect(pool.watchedSubscriptions()).toEqual([
			{ backend: "gh", jobRef: "job", subscriberId: "", scheduleMs: undefined, lastCheckedAt: undefined },
		]);
	});

	it("markSubscriptionChecked records lastCheckedAt for exactly the given subscriber", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("gh", "job", { subscriberId: "alice" });
		pool.subscribeJob("gh", "job", { subscriberId: "bob" });

		pool.markSubscriptionChecked("gh", "job", "alice", new Date(5000));

		const subs = pool.watchedSubscriptions();
		expect(subs.find((s) => s.subscriberId === "alice")?.lastCheckedAt?.getTime()).toBe(5000);
		expect(subs.find((s) => s.subscriberId === "bob")?.lastCheckedAt).toBeUndefined();
	});
});

describe("createRunPool: pinning a subscription to a specific runId instead of always tracking latest", () => {
	it("subscribeJob's runId option round-trips through watchedSubscriptions() as pinnedRunId", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("jenkins", "job", { runId: "9191" });

		const subs = pool.watchedSubscriptions();
		expect(subs).toHaveLength(1);
		expect(subs[0]?.pinnedRunId).toBe("9191");
	});

	it("a subscription with no runId option shows pinnedRunId undefined -- back-compat, tracks latest as before", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("jenkins", "job");

		const subs = pool.watchedSubscriptions();
		expect(subs[0]?.pinnedRunId).toBeUndefined();
	});

	it("two subscribers on the same job can independently pin to different runs, or not pin at all", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("jenkins", "job", { subscriberId: "alice", runId: "9191" });
		pool.subscribeJob("jenkins", "job", { subscriberId: "bob" });

		const subs = pool.watchedSubscriptions();
		expect(subs.find((s) => s.subscriberId === "alice")?.pinnedRunId).toBe("9191");
		expect(subs.find((s) => s.subscriberId === "bob")?.pinnedRunId).toBeUndefined();
	});
});

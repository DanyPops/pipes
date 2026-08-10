import { describe, expect, it } from "bun:test";
import { findVehicleProject, registerVehicleProject } from "@danypops/vehicle-server/project-scope";
import { openPipesDb } from "../../src/sqlite/db.ts";
import { createRunPool, createSqliteVehicleProjectStore, isTerminalStatus, type RunSnapshot } from "../../src/sqlite/run-pool.ts";

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

	it("round-trips progressPercent/estimatedMs/overdue when the caller provides them", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.upsert(snapshot({ progressPercent: 42.5, estimatedMs: 60_000, overdue: true }));
		const got = pool.get("gh", "job", "1");
		expect(got?.progressPercent).toBe(42.5);
		expect(got?.estimatedMs).toBe(60_000);
		expect(got?.overdue).toBe(true);
	});

	it("leaves progressPercent/estimatedMs/overdue undefined, not a misleading 0/false, when the caller omits them (e.g. GitLab's own estimateDuration always returning 0)", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.upsert(snapshot());
		const got = pool.get("gh", "job", "1");
		expect(got?.progressPercent).toBeUndefined();
		expect(got?.estimatedMs).toBeUndefined();
		expect(got?.overdue).toBeUndefined();
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

describe("createRunPool: clearWatchedForJob", () => {
	it("flips a cached run's watched flag back to false, independent of job_watches", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.upsert({
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

		pool.clearWatchedForJob("gh", "job");

		expect(pool.get("gh", "job", "1")?.watched).toBe(false);
		expect(pool.watchedRuns()).toEqual([]);
	});

	it("is idempotent/safe when no cached run exists for the job", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		expect(() => pool.clearWatchedForJob("gh", "nonexistent")).not.toThrow();
	});

	it("does not touch a different job's cached watched run", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.upsert({
			backend: "gh",
			jobRef: "other",
			runId: "9",
			status: "running",
			result: "",
			url: "",
			startedAt: new Date(0),
			fetchedAt: new Date(0),
			watched: true,
		});

		pool.clearWatchedForJob("gh", "job");

		expect(pool.get("gh", "other", "9")?.watched).toBe(true);
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

describe("createRunPool: project scope (which project/session subscribed)", () => {
	it("subscribeJob's projectRoot option round-trips through watchedSubscriptions()", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("jenkins", "job", { projectRoot: "/home/x/pipes" });

		const subs = pool.watchedSubscriptions();
		expect(subs[0]?.projectRoot).toBe("/home/x/pipes");
	});

	it("a subscription with no projectRoot option shows projectRoot undefined -- back-compat, e.g. a raw RPC client with no Pi session behind it", () => {
		const pool = createRunPool(openPipesDb(":memory:"));
		pool.subscribeJob("jenkins", "job");

		expect(pool.watchedSubscriptions()[0]?.projectRoot).toBeUndefined();
	});
});

describe("createSqliteVehicleProjectStore", () => {
	it("implements @danypops/vehicle-server/project-scope's VehicleProjectStore port -- round-trips through registerVehicleProject/findVehicleProject", () => {
		const store = createSqliteVehicleProjectStore(openPipesDb(":memory:"));
		const project = registerVehicleProject(store, { projectRoot: "/home/x/pipes" });

		expect(project.name).toBe("pipes");
		expect(findVehicleProject(store, "/home/x/pipes")).toEqual(project);
		expect(findVehicleProject(store, "/home/x/never-seen")).toBeUndefined();
	});

	it("is idempotent by root, same as the in-memory reference implementation", () => {
		const store = createSqliteVehicleProjectStore(openPipesDb(":memory:"));
		const first = registerVehicleProject(store, { projectRoot: "/home/x/pipes" });
		const second = registerVehicleProject(store, { projectRoot: "/home/x/pipes", name: "Pipes CI" });

		expect(second.id).toBe(first.id);
		expect(second.name).toBe("Pipes CI");
	});
});

describe("createRunPool: watchedRunsWithProjectLabels", () => {
	it("attaches the subscribing project's own name to a watched run", () => {
		const db = openPipesDb(":memory:");
		const pool = createRunPool(db);
		const store = createSqliteVehicleProjectStore(db);
		registerVehicleProject(store, { projectRoot: "/home/x/pipes" });
		pool.subscribeJob("jenkins", "job", { projectRoot: "/home/x/pipes" });
		pool.upsert(snapshot({ backend: "jenkins", jobRef: "job", runId: "1", watched: true }));

		const rows = pool.watchedRunsWithProjectLabels();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.projectRoot).toBe("/home/x/pipes");
		expect(rows[0]?.projectName).toBe("pipes");
	});

	it("leaves projectRoot/projectName undefined for a run whose subscription never carried one (e.g. a raw RPC client)", () => {
		const db = openPipesDb(":memory:");
		const pool = createRunPool(db);
		pool.subscribeJob("jenkins", "job");
		pool.upsert(snapshot({ backend: "jenkins", jobRef: "job", runId: "1", watched: true }));

		const rows = pool.watchedRunsWithProjectLabels();
		expect(rows[0]?.projectRoot).toBeUndefined();
		expect(rows[0]?.projectName).toBeUndefined();
	});

	it("leaves projectName undefined when a project root was recorded on the subscription but never actually registered", () => {
		const db = openPipesDb(":memory:");
		const pool = createRunPool(db);
		pool.subscribeJob("jenkins", "job", { projectRoot: "/home/x/never-registered" });
		pool.upsert(snapshot({ backend: "jenkins", jobRef: "job", runId: "1", watched: true }));

		const rows = pool.watchedRunsWithProjectLabels();
		expect(rows[0]?.projectRoot).toBe("/home/x/never-registered");
		expect(rows[0]?.projectName).toBeUndefined();
	});

	it("does not attach a label from a different job's own subscription", () => {
		const db = openPipesDb(":memory:");
		const pool = createRunPool(db);
		const store = createSqliteVehicleProjectStore(db);
		registerVehicleProject(store, { projectRoot: "/home/x/pipes" });
		pool.subscribeJob("jenkins", "job-a", { projectRoot: "/home/x/pipes" });
		pool.subscribeJob("jenkins", "job-b");
		pool.upsert(snapshot({ backend: "jenkins", jobRef: "job-a", runId: "1", watched: true }));
		pool.upsert(snapshot({ backend: "jenkins", jobRef: "job-b", runId: "2", watched: true }));

		const rows = pool.watchedRunsWithProjectLabels();
		expect(rows.find((r) => r.jobRef === "job-a")?.projectName).toBe("pipes");
		expect(rows.find((r) => r.jobRef === "job-b")?.projectName).toBeUndefined();
	});

	it("an optional subscriberId filter returns only runs that subscriber itself is watching -- the cross-session leak fix", () => {
		const db = openPipesDb(":memory:");
		const pool = createRunPool(db);
		pool.subscribeJob("jenkins", "deploy-a", { subscriberId: "session-a" });
		pool.subscribeJob("github", "build-b", { subscriberId: "session-b" });
		pool.upsert(snapshot({ backend: "jenkins", jobRef: "deploy-a", runId: "1", watched: true }));
		pool.upsert(snapshot({ backend: "github", jobRef: "build-b", runId: "2", watched: true }));

		const rowsForA = pool.watchedRunsWithProjectLabels("session-a");
		expect(rowsForA.map((r) => r.jobRef)).toEqual(["deploy-a"]);

		const rowsForB = pool.watchedRunsWithProjectLabels("session-b");
		expect(rowsForB.map((r) => r.jobRef)).toEqual(["build-b"]);
	});

	it("a job with more than one subscriber (including the filtered-for one) still shows up for that subscriber", () => {
		const db = openPipesDb(":memory:");
		const pool = createRunPool(db);
		pool.subscribeJob("jenkins", "job", { subscriberId: "session-a" });
		pool.subscribeJob("jenkins", "job", { subscriberId: "session-b" });
		pool.upsert(snapshot({ backend: "jenkins", jobRef: "job", runId: "1", watched: true }));

		expect(pool.watchedRunsWithProjectLabels("session-a").map((r) => r.jobRef)).toEqual(["job"]);
		expect(pool.watchedRunsWithProjectLabels("session-c")).toEqual([]);
	});

	it("omitting subscriberId keeps today's global, unscoped view -- back-compat", () => {
		const db = openPipesDb(":memory:");
		const pool = createRunPool(db);
		pool.subscribeJob("jenkins", "deploy-a", { subscriberId: "session-a" });
		pool.subscribeJob("github", "build-b", { subscriberId: "session-b" });
		pool.upsert(snapshot({ backend: "jenkins", jobRef: "deploy-a", runId: "1", watched: true }));
		pool.upsert(snapshot({ backend: "github", jobRef: "build-b", runId: "2", watched: true }));

		expect(
			pool
				.watchedRunsWithProjectLabels()
				.map((r) => r.jobRef)
				.sort(),
		).toEqual(["build-b", "deploy-a"]);
	});
});

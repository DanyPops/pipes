import { describe, expect, it } from "bun:test";
import { openPipesDb } from "../../src/sqlite/db.ts";

describe("openPipesDb", () => {
	it("creates the run_snapshots schema (including log_text) and is safe to reopen (idempotent migration)", () => {
		const db = openPipesDb(":memory:");
		db.query(
			"INSERT INTO run_snapshots (backend, job_ref, run_id, status, url, started_at, fetched_at, watched, log_text) VALUES ('gh', 'job', '1', 'success', '', 0, 0, 0, 'hello')",
		).run();
		const row = db.query("SELECT * FROM run_snapshots WHERE run_id = '1'").get() as { log_text: string };
		expect(row).toBeDefined();
		expect(row.log_text).toBe("hello");
		db.close();
	});

	it("creates the job_watches schema with (backend, job_ref) as its primary key", () => {
		const db = openPipesDb(":memory:");
		db.query("INSERT INTO job_watches (backend, job_ref) VALUES ('gh', 'job')").run();
		expect(() => db.query("INSERT INTO job_watches (backend, job_ref) VALUES ('gh', 'job')").run()).toThrow();
		db.close();
	});

	it("adds progress_percent/estimated_ms/overdue columns to run_snapshots, nullable so a pre-migration row still reads back fine", () => {
		const db = openPipesDb(":memory:");
		db.query(
			"INSERT INTO run_snapshots (backend, job_ref, run_id, status, url, started_at, fetched_at, watched) VALUES ('gh', 'job', '1', 'running', '', 0, 0, 1)",
		).run();
		const row = db.query("SELECT * FROM run_snapshots WHERE run_id = '1'").get() as {
			progress_percent: number | null;
			estimated_ms: number | null;
			overdue: number | null;
		};
		expect(row.progress_percent).toBeNull();
		expect(row.estimated_ms).toBeNull();
		expect(row.overdue).toBeNull();

		db.query("UPDATE run_snapshots SET progress_percent = ?, estimated_ms = ?, overdue = ? WHERE run_id = '1'").run(42.5, 60000, 1);
		const updated = db.query("SELECT * FROM run_snapshots WHERE run_id = '1'").get() as {
			progress_percent: number | null;
			estimated_ms: number | null;
			overdue: number | null;
		};
		expect(updated.progress_percent).toBe(42.5);
		expect(updated.estimated_ms).toBe(60000);
		expect(updated.overdue).toBe(1);
		db.close();
	});
});

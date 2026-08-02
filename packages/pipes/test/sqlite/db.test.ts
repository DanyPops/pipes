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
});

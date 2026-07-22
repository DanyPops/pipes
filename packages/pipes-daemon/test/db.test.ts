import { describe, expect, it } from "bun:test";
import { openPipesDb } from "../src/db.ts";

describe("openPipesDb", () => {
	it("creates the run_snapshots schema and is safe to reopen (idempotent migration)", () => {
		const db = openPipesDb(":memory:");
		db.query(
			"INSERT INTO run_snapshots (backend, job_ref, run_id, status, url, started_at, fetched_at, watched) VALUES ('gh', 'job', '1', 'success', '', 0, 0, 0)",
		).run();
		const row = db.query("SELECT * FROM run_snapshots WHERE run_id = '1'").get();
		expect(row).toBeDefined();
		db.close();
	});
});

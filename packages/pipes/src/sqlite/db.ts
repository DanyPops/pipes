/**
 * SQLite composition root. Bootstrap (pragmas, PRAGMA user_version
 * migration runner) delegates to @danypops/vehicle-server's storage module.
 * Schema: one table, run_snapshots — the local pool of last-known run
 * status per (backend, job_ref, run_id), independent of any live backend
 * call. `watched` marks rows the background sync loop should keep
 * refreshing; it's cleared once a run reaches a terminal status so the
 * pool doesn't poll finished work forever.
 */
import type { Database } from "bun:sqlite";
import { openSqliteWithPragmas } from "@danypops/vehicle-server/storage";

const INITIAL_SCHEMA = `
CREATE TABLE run_snapshots (
	backend     TEXT NOT NULL,
	job_ref     TEXT NOT NULL,
	run_id      TEXT NOT NULL,
	status      TEXT NOT NULL,
	result      TEXT NOT NULL DEFAULT '',
	url         TEXT NOT NULL DEFAULT '',
	started_at  INTEGER NOT NULL DEFAULT 0,
	duration_ms INTEGER,
	fetched_at  INTEGER NOT NULL,
	watched     INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (backend, job_ref, run_id)
);
CREATE INDEX run_snapshots_watched_idx ON run_snapshots(watched);
`;

// The full raw log the background sync (or an explicit ci.tail fallback fetch)
// last observed for a run — kept complete and untruncated; truncation only
// ever happens on read, in truncate.ts, never on write.
const MIGRATION_2_LOG_TEXT = `
ALTER TABLE run_snapshots ADD COLUMN log_text TEXT NOT NULL DEFAULT '';
`;

// Job-level watch list: presence of a row means the background sync keeps
// resolving this job's *latest* run every tick (auto-refocusing onto a new
// run if one supersedes it) and auto-deletes the row once that latest run
// reaches a terminal status. This is the authoritative list the sync loop
// iterates — run_snapshots.watched is informational only, per run observed,
// not what drives polling.
const MIGRATION_3_JOB_WATCHES = `
CREATE TABLE job_watches (
	backend TEXT NOT NULL,
	job_ref TEXT NOT NULL,
	PRIMARY KEY (backend, job_ref)
);
`;

// Widens a job watch from one shared, anonymous subscription per (backend, job_ref)
// into one subscription per (backend, job_ref, subscriber_id) -- several subscribers
// can now watch the same job independently, each with its own optional check cadence.
// subscriber_id defaults to '' so every pre-existing row (and every caller that never
// passes one) keeps behaving exactly as it did under the old single-row-per-job schema.
// schedule_ms is nullable: null means "check on every global sync tick", today's only
// behavior; a set value means this subscriber doesn't need checking more often than that.
const MIGRATION_4_SUBSCRIBER_SCHEDULES = `
CREATE TABLE job_watches_new (
	backend TEXT NOT NULL,
	job_ref TEXT NOT NULL,
	subscriber_id TEXT NOT NULL DEFAULT '',
	schedule_ms INTEGER,
	last_checked_at INTEGER,
	PRIMARY KEY (backend, job_ref, subscriber_id)
);
INSERT INTO job_watches_new (backend, job_ref, subscriber_id)
	SELECT backend, job_ref, '' FROM job_watches;
DROP TABLE job_watches;
ALTER TABLE job_watches_new RENAME TO job_watches;
`;

// A subscription with pinned_run_id set tracks that exact run forever, never re-resolving
// "latest" -- the fix for a real bug where a busy/shared job's background watch silently
// jumped onto an unrelated concurrent run. Null (the default, and every pre-4 row after
// migration 4 backfills it implicitly via ALTER TABLE's column default) preserves today's
// "always track latest" behavior.
const MIGRATION_5_PINNED_RUN_ID = `
ALTER TABLE job_watches ADD COLUMN pinned_run_id TEXT;
`;

export function openPipesDb(path: string): Database {
	return openSqliteWithPragmas(path, {
		databaseOptions: { create: true, strict: true },
		migrations: [
			{ version: 1, up: (db) => db.exec(INITIAL_SCHEMA) },
			{ version: 2, up: (db) => db.exec(MIGRATION_2_LOG_TEXT) },
			{ version: 3, up: (db) => db.exec(MIGRATION_3_JOB_WATCHES) },
			{ version: 4, up: (db) => db.exec(MIGRATION_4_SUBSCRIBER_SCHEDULES) },
			{ version: 5, up: (db) => db.exec(MIGRATION_5_PINNED_RUN_ID) },
		],
	});
}

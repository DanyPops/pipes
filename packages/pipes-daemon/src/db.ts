/**
 * SQLite composition root. Bootstrap (pragmas, PRAGMA user_version
 * migration runner) delegates to @danypops/daemon-kit's storage module.
 * Schema: one table, run_snapshots — the local pool of last-known run
 * status per (backend, job_ref, run_id), independent of any live backend
 * call. `watched` marks rows the background sync loop should keep
 * refreshing; it's cleared once a run reaches a terminal status so the
 * pool doesn't poll finished work forever.
 */
import type { Database } from "bun:sqlite";
import { openSqliteWithPragmas } from "@danypops/daemon-kit/storage";

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

export function openPipesDb(path: string): Database {
	return openSqliteWithPragmas(path, {
		databaseOptions: { create: true, strict: true },
		migrations: [
			{ version: 1, up: (db) => db.exec(INITIAL_SCHEMA) },
			{ version: 2, up: (db) => db.exec(MIGRATION_2_LOG_TEXT) },
			{ version: 3, up: (db) => db.exec(MIGRATION_3_JOB_WATCHES) },
		],
	});
}

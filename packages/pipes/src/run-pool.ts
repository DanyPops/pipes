/**
 * Local pool of last-known run status per (backend, jobRef, runId),
 * independent of any live backend call — the standalone-adapter shape:
 * data collected here stays queryable even when nothing is actively
 * polling a live CI backend right now.
 */
import type { Database } from "bun:sqlite";
import { isTerminalStatus, type RunStatus } from "./domain/ci-run.ts";

/** Re-exported so callers of run-pool.ts don't need a second import from domain/ci-run.ts — there is exactly one definition, in the domain layer. */
export { isTerminalStatus };

export interface RunSnapshot {
	backend: string;
	jobRef: string;
	runId: string;
	status: RunStatus;
	result: string;
	url: string;
	startedAt: Date;
	durationMs?: number;
	fetchedAt: Date;
	/** Whether the background sync loop should keep refreshing this row. Cleared once terminal. */
	watched: boolean;
}

export interface RunPool {
	upsert(snapshot: RunSnapshot): void;
	get(backend: string, jobRef: string, runId: string): RunSnapshot | undefined;
	recent(backend: string, jobRef: string, limit: number): RunSnapshot[];
	/** Rows the background sync loop should refresh next tick — never the full table, always bounded by the watched flag itself. */
	watchedRuns(): RunSnapshot[];

	/** Full cached log text for one run, or undefined if nothing has ever been fetched for it. */
	getLog(backend: string, jobRef: string, runId: string): string | undefined;
	/** Overwrites the cached log with the complete, untruncated text — truncation only ever happens on read. */
	upsertLog(backend: string, jobRef: string, runId: string, logText: string): void;

	/** Job-level watch list: presence means the background sync keeps resolving and refreshing this job's latest run. Idempotent. */
	subscribeJob(backend: string, jobRef: string): void;
	/** Idempotent no-op if the job wasn't subscribed. */
	unsubscribeJob(backend: string, jobRef: string): void;
	isJobSubscribed(backend: string, jobRef: string): boolean;
	watchedJobs(): Array<{ backend: string; jobRef: string }>;
}

interface RunRow {
	backend: string;
	job_ref: string;
	run_id: string;
	status: string;
	result: string;
	url: string;
	started_at: number;
	duration_ms: number | null;
	fetched_at: number;
	watched: number;
}

function toSnapshot(row: RunRow): RunSnapshot {
	return {
		backend: row.backend,
		jobRef: row.job_ref,
		runId: row.run_id,
		status: row.status as RunStatus,
		result: row.result,
		url: row.url,
		startedAt: new Date(row.started_at),
		durationMs: row.duration_ms ?? undefined,
		fetchedAt: new Date(row.fetched_at),
		watched: row.watched === 1,
	};
}

export function createRunPool(db: Database): RunPool {
	return {
		upsert(snapshot: RunSnapshot): void {
			db.query(`
				INSERT INTO run_snapshots (backend, job_ref, run_id, status, result, url, started_at, duration_ms, fetched_at, watched)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(backend, job_ref, run_id) DO UPDATE SET
					status = excluded.status, result = excluded.result, url = excluded.url,
					started_at = excluded.started_at, duration_ms = excluded.duration_ms,
					fetched_at = excluded.fetched_at, watched = excluded.watched
			`).run(
				snapshot.backend,
				snapshot.jobRef,
				snapshot.runId,
				snapshot.status,
				snapshot.result,
				snapshot.url,
				snapshot.startedAt.getTime(),
				snapshot.durationMs ?? null,
				snapshot.fetchedAt.getTime(),
				snapshot.watched ? 1 : 0,
			);
		},

		get(backend: string, jobRef: string, runId: string): RunSnapshot | undefined {
			const row = db
				.query("SELECT * FROM run_snapshots WHERE backend = ? AND job_ref = ? AND run_id = ?")
				.get(backend, jobRef, runId) as RunRow | null;
			return row ? toSnapshot(row) : undefined;
		},

		recent(backend: string, jobRef: string, limit: number): RunSnapshot[] {
			const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
			const rows = db
				.query("SELECT * FROM run_snapshots WHERE backend = ? AND job_ref = ? ORDER BY fetched_at DESC LIMIT ?")
				.all(backend, jobRef, bounded) as RunRow[];
			return rows.map(toSnapshot);
		},

		watchedRuns(): RunSnapshot[] {
			const rows = db.query("SELECT * FROM run_snapshots WHERE watched = 1").all() as RunRow[];
			return rows.map(toSnapshot);
		},

		getLog(backend: string, jobRef: string, runId: string): string | undefined {
			const row = db
				.query("SELECT log_text FROM run_snapshots WHERE backend = ? AND job_ref = ? AND run_id = ?")
				.get(backend, jobRef, runId) as { log_text: string } | null;
			return row?.log_text;
		},

		upsertLog(backend: string, jobRef: string, runId: string, logText: string): void {
			db.query("UPDATE run_snapshots SET log_text = ? WHERE backend = ? AND job_ref = ? AND run_id = ?").run(
				logText,
				backend,
				jobRef,
				runId,
			);
		},

		subscribeJob(backend: string, jobRef: string): void {
			db.query("INSERT OR IGNORE INTO job_watches (backend, job_ref) VALUES (?, ?)").run(backend, jobRef);
		},

		unsubscribeJob(backend: string, jobRef: string): void {
			db.query("DELETE FROM job_watches WHERE backend = ? AND job_ref = ?").run(backend, jobRef);
		},

		isJobSubscribed(backend: string, jobRef: string): boolean {
			return db.query("SELECT 1 FROM job_watches WHERE backend = ? AND job_ref = ?").get(backend, jobRef) !== null;
		},

		watchedJobs(): Array<{ backend: string; jobRef: string }> {
			const rows = db.query("SELECT backend, job_ref FROM job_watches").all() as Array<{ backend: string; job_ref: string }>;
			return rows.map((row) => ({ backend: row.backend, jobRef: row.job_ref }));
		},
	};
}

/**
 * Local pool of last-known run status per (backend, jobRef, runId),
 * independent of any live backend call — the standalone-adapter shape:
 * data collected here stays queryable even when nothing is actively
 * polling a live CI backend right now.
 */
import type { Database } from "bun:sqlite";
import type { RunStatus } from "./domain/ci-run.ts";

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

export function isTerminalStatus(status: RunStatus): boolean {
	return status === "success" || status === "failure" || status === "aborted" || status === "not_found";
}

export interface RunPool {
	upsert(snapshot: RunSnapshot): void;
	get(backend: string, jobRef: string, runId: string): RunSnapshot | undefined;
	recent(backend: string, jobRef: string, limit: number): RunSnapshot[];
	/** Rows the background sync loop should refresh next tick — never the full table, always bounded by the watched flag itself. */
	watchedRuns(): RunSnapshot[];
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
	};
}

/**
 * Local pool of last-known run status per (backend, jobRef, runId),
 * independent of any live backend call — the standalone-adapter shape:
 * data collected here stays queryable even when nothing is actively
 * polling a live CI backend right now.
 */
import type { Database } from "bun:sqlite";
import { isTerminalStatus, type RunStatus } from "../run/ci-run.ts";

/** Re-exported so callers of run-pool.ts don't need a second import from run/ci-run.ts — there is exactly one definition, in the run domain. */
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

	/**
	 * Job-level watch list: presence means the background sync keeps resolving and refreshing
	 * this job's latest run. Idempotent per (backend, jobRef, subscriberId). subscriberId
	 * defaults to "" -- the anonymous/shared subscriber every pre-existing caller implicitly
	 * uses. scheduleMs, when set, is this subscriber's own minimum check cadence in
	 * milliseconds; omitted means "check on every global sync tick", matching the pre-existing
	 * single-subscriber behavior. runId, when set, pins this subscription to that exact run
	 * forever instead of always re-resolving "latest" -- the only safe way to track a specific
	 * triggered run on a job with other unrelated concurrent triggers.
	 */
	subscribeJob(backend: string, jobRef: string, options?: { subscriberId?: string; scheduleMs?: number; runId?: string }): void;
	/** Removes exactly one subscriber's row. subscriberId defaults to "". Idempotent no-op if that subscription wasn't present. */
	unsubscribeJob(backend: string, jobRef: string, subscriberId?: string): void;
	/** True if the given subscriber (default "") is currently watching this job. */
	isJobSubscribed(backend: string, jobRef: string, subscriberId?: string): boolean;
	/** Distinct (backend, jobRef) pairs with at least one subscriber -- what the sync loop fetches, deduped across however many subscribers are watching each job. */
	watchedJobs(): Array<{ backend: string; jobRef: string }>;
	/** Every individual subscription row, one per (backend, jobRef, subscriberId) -- the schedule-aware view watchedJobs() collapses away. */
	watchedSubscriptions(): JobSubscription[];
	/** Removes every subscriber currently watching this job in one call -- used once a job's latest run reaches a terminal status, a job-level fact no subscriber's schedule should keep polling past. */
	unsubscribeAllForJob(backend: string, jobRef: string): void;
	/** Records that this exact subscription was just checked, for schedule due-time gating. */
	markSubscriptionChecked(backend: string, jobRef: string, subscriberId: string, at: Date): void;
}

export interface JobSubscription {
	backend: string;
	jobRef: string;
	subscriberId: string;
	scheduleMs?: number;
	lastCheckedAt?: Date;
	/** When set, this subscription tracks exactly this run id, never "latest". */
	pinnedRunId?: string;
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

		subscribeJob(backend: string, jobRef: string, options?: { subscriberId?: string; scheduleMs?: number; runId?: string }): void {
			const subscriberId = options?.subscriberId ?? "";
			db.query(
				`INSERT INTO job_watches (backend, job_ref, subscriber_id, schedule_ms, pinned_run_id)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(backend, job_ref, subscriber_id) DO UPDATE SET schedule_ms = excluded.schedule_ms, pinned_run_id = excluded.pinned_run_id`,
			).run(backend, jobRef, subscriberId, options?.scheduleMs ?? null, options?.runId ?? null);
		},

		unsubscribeJob(backend: string, jobRef: string, subscriberId = ""): void {
			db.query("DELETE FROM job_watches WHERE backend = ? AND job_ref = ? AND subscriber_id = ?").run(backend, jobRef, subscriberId);
		},

		isJobSubscribed(backend: string, jobRef: string, subscriberId = ""): boolean {
			return (
				db.query("SELECT 1 FROM job_watches WHERE backend = ? AND job_ref = ? AND subscriber_id = ?").get(backend, jobRef, subscriberId) !==
				null
			);
		},

		watchedJobs(): Array<{ backend: string; jobRef: string }> {
			const rows = db.query("SELECT DISTINCT backend, job_ref FROM job_watches").all() as Array<{ backend: string; job_ref: string }>;
			return rows.map((row) => ({ backend: row.backend, jobRef: row.job_ref }));
		},

		watchedSubscriptions(): JobSubscription[] {
			const rows = db.query("SELECT * FROM job_watches").all() as Array<{
				backend: string;
				job_ref: string;
				subscriber_id: string;
				schedule_ms: number | null;
				last_checked_at: number | null;
				pinned_run_id: string | null;
			}>;
			return rows.map((row) => ({
				backend: row.backend,
				jobRef: row.job_ref,
				subscriberId: row.subscriber_id,
				scheduleMs: row.schedule_ms ?? undefined,
				lastCheckedAt: row.last_checked_at !== null ? new Date(row.last_checked_at) : undefined,
				pinnedRunId: row.pinned_run_id ?? undefined,
			}));
		},

		unsubscribeAllForJob(backend: string, jobRef: string): void {
			db.query("DELETE FROM job_watches WHERE backend = ? AND job_ref = ?").run(backend, jobRef);
		},

		markSubscriptionChecked(backend: string, jobRef: string, subscriberId: string, at: Date): void {
			db.query("UPDATE job_watches SET last_checked_at = ? WHERE backend = ? AND job_ref = ? AND subscriber_id = ?").run(
				at.getTime(),
				backend,
				jobRef,
				subscriberId,
			);
		},
	};
}

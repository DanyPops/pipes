/**
 * Local pool of last-known run status per (backend, jobRef, runId),
 * independent of any live backend call — the standalone-adapter shape:
 * data collected here stays queryable even when nothing is actively
 * polling a live CI backend right now.
 */
import type { Database } from "bun:sqlite";
import type { VehicleProjectStore } from "@danypops/vehicle-server/project-scope";
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
	/** Real-time progress, same elapsed/estimated math orchestrator.ts's ciWatch already reports live
	 * for ci_wait -- see ciGetRunWithProgress. Undefined (not 0/false) when the backend has no real
	 * estimate to compute from (e.g. GitLab's estimateDuration() always returns 0), so a consumer can
	 * tell "no progress data" apart from "0% progress". */
	progressPercent?: number;
	estimatedMs?: number;
	overdue?: boolean;
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
	subscribeJob(
		backend: string,
		jobRef: string,
		options?: { subscriberId?: string; scheduleMs?: number; runId?: string; projectRoot?: string },
	): void;
	/** Removes exactly one subscriber's row. subscriberId defaults to "". Idempotent no-op if that subscription wasn't present. */
	unsubscribeJob(backend: string, jobRef: string, subscriberId?: string): void;
	/**
	 * Flips run_snapshots.watched back to false for every cached run of this (backend, jobRef) --
	 * a completely separate store from job_watches (see unsubscribeJob), read directly by
	 * watchedRuns()/watchedRunsWithProjectLabels()/ci.subscribed. Without this, an explicit
	 * unsubscribe only ever removed the job_watches row; the background sync loop's own
	 * natural-completion path (process/pool-sync.ts) is the only other thing that ever clears
	 * watched, and it never runs again for a job nothing is left subscribed to -- leaving the
	 * stale watched=1 row (and whatever status happened to be cached at unsubscribe time) stuck
	 * forever. Idempotent no-op if no cached run exists for this job.
	 */
	clearWatchedForJob(backend: string, jobRef: string): void;
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
	/**
	 * Same rows as watchedRuns(), each annotated with the subscribing project's own root/name --
	 * see @danypops/vehicle-server/project-scope's VehicleProject. A job with more than one
	 * subscriber picks whichever subscription happens to carry a project_root first (matching
	 * this daemon's own "one label is enough, this isn't a set-membership feature" scope); both
	 * fields are undefined when no subscription on this job ever carried a projectRoot, or the
	 * root it carried was never actually registered as a project.
	 *
	 * subscriberId, when given, scopes the result to only jobs that exact subscriber is itself
	 * watching (a real job_watches row for that backend/jobRef/subscriber_id) -- the fix for a
	 * real, proven cross-session leak: ci.subscribed used to return every watched run globally to
	 * any caller, so one Pi session's own job-finished notification reached every other session's
	 * ticker too. Omitted (the default), this keeps today's global, unscoped view -- e.g. a raw
	 * RPC client with no session identity to filter by.
	 */
	watchedRunsWithProjectLabels(subscriberId?: string): Array<RunSnapshot & { projectRoot?: string; projectName?: string }>;
}

export interface JobSubscription {
	backend: string;
	jobRef: string;
	subscriberId: string;
	scheduleMs?: number;
	lastCheckedAt?: Date;
	/** When set, this subscription tracks exactly this run id, never "latest". */
	pinnedRunId?: string;
	/** The calling Pi session's own cwd at ci.subscribe time, if any -- see this file's own VehicleProjectStore doc comment. */
	projectRoot?: string;
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
	progress_percent: number | null;
	estimated_ms: number | null;
	overdue: number | null;
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
		progressPercent: row.progress_percent ?? undefined,
		estimatedMs: row.estimated_ms ?? undefined,
		overdue: row.overdue === null ? undefined : row.overdue === 1,
	};
}

export function createRunPool(db: Database): RunPool {
	return {
		upsert(snapshot: RunSnapshot): void {
			db.query(`
				INSERT INTO run_snapshots (backend, job_ref, run_id, status, result, url, started_at, duration_ms, fetched_at, watched, progress_percent, estimated_ms, overdue)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(backend, job_ref, run_id) DO UPDATE SET
					status = excluded.status, result = excluded.result, url = excluded.url,
					started_at = excluded.started_at, duration_ms = excluded.duration_ms,
					fetched_at = excluded.fetched_at, watched = excluded.watched,
					progress_percent = excluded.progress_percent, estimated_ms = excluded.estimated_ms, overdue = excluded.overdue
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
				snapshot.progressPercent ?? null,
				snapshot.estimatedMs ?? null,
				snapshot.overdue === undefined ? null : snapshot.overdue ? 1 : 0,
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

		subscribeJob(
			backend: string,
			jobRef: string,
			options?: { subscriberId?: string; scheduleMs?: number; runId?: string; projectRoot?: string },
		): void {
			const subscriberId = options?.subscriberId ?? "";
			db.query(
				`INSERT INTO job_watches (backend, job_ref, subscriber_id, schedule_ms, pinned_run_id, project_root)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(backend, job_ref, subscriber_id) DO UPDATE SET schedule_ms = excluded.schedule_ms, pinned_run_id = excluded.pinned_run_id, project_root = excluded.project_root`,
			).run(backend, jobRef, subscriberId, options?.scheduleMs ?? null, options?.runId ?? null, options?.projectRoot ?? null);
		},

		unsubscribeJob(backend: string, jobRef: string, subscriberId = ""): void {
			db.query("DELETE FROM job_watches WHERE backend = ? AND job_ref = ? AND subscriber_id = ?").run(backend, jobRef, subscriberId);
		},

		clearWatchedForJob(backend: string, jobRef: string): void {
			db.query("UPDATE run_snapshots SET watched = 0 WHERE backend = ? AND job_ref = ?").run(backend, jobRef);
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
				project_root: string | null;
			}>;
			return rows.map((row) => ({
				backend: row.backend,
				jobRef: row.job_ref,
				subscriberId: row.subscriber_id,
				scheduleMs: row.schedule_ms ?? undefined,
				lastCheckedAt: row.last_checked_at !== null ? new Date(row.last_checked_at) : undefined,
				pinnedRunId: row.pinned_run_id ?? undefined,
				projectRoot: row.project_root ?? undefined,
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

		watchedRunsWithProjectLabels(subscriberId?: string): Array<RunSnapshot & { projectRoot?: string; projectName?: string }> {
			const rows = (
				subscriberId === undefined
					? db.query("SELECT * FROM run_snapshots WHERE watched = 1").all()
					: db
							.query(
								`SELECT * FROM run_snapshots WHERE watched = 1 AND EXISTS (
									SELECT 1 FROM job_watches
									WHERE job_watches.backend = run_snapshots.backend
									  AND job_watches.job_ref = run_snapshots.job_ref
									  AND job_watches.subscriber_id = ?
								)`,
							)
							.all(subscriberId)
			) as RunRow[];
			return rows.map((row) => {
				const snapshot = toSnapshot(row);
				const subscription = db
					.query("SELECT project_root FROM job_watches WHERE backend = ? AND job_ref = ? AND project_root IS NOT NULL LIMIT 1")
					.get(snapshot.backend, snapshot.jobRef) as { project_root: string } | null;
				if (!subscription) return snapshot;
				const project = db.query("SELECT name FROM vehicle_projects WHERE project_root = ?").get(subscription.project_root) as {
					name: string;
				} | null;
				return { ...snapshot, projectRoot: subscription.project_root, projectName: project?.name };
			});
		},
	};
}

/** SQLite-backed implementation of @danypops/vehicle-server/project-scope's VehicleProjectStore
 * port, sharing this daemon's own database handle -- one row per registered project root. See
 * rpc/service.ts's ci.subscribe handler for where a project gets auto-registered (lazily, on
 * first sight of a caller's own projectRoot), unlike Papyrus's own Task/Doc/Rule/Playbook domain,
 * which requires an explicit registration step -- a lightweight CI-job subscription auto-
 * registering its own project is a reasonable, much cheaper default for this domain. */
export function createSqliteVehicleProjectStore(db: Database): VehicleProjectStore {
	return {
		findByRoot(projectRoot: string) {
			const row = db.query("SELECT * FROM vehicle_projects WHERE project_root = ?").get(projectRoot) as {
				id: string;
				name: string;
				project_root: string;
				created_at: string;
				updated_at: string;
			} | null;
			return row
				? { id: row.id, name: row.name, projectRoot: row.project_root, createdAt: row.created_at, updatedAt: row.updated_at }
				: undefined;
		},
		upsert(project) {
			db.query(
				`INSERT INTO vehicle_projects (id, name, project_root, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(project_root) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
			).run(project.id, project.name, project.projectRoot, project.createdAt, project.updatedAt);
		},
	};
}

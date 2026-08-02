/**
 * Background sync: for every watched *job* (not a fixed run ID), resolves
 * whatever "latest" currently means for that job and refreshes its status
 * and full log through the real orchestrator/adapter path. Re-resolving
 * "latest" every tick is what gives autofocus for free -- if a new run
 * supersedes the one last observed, the very next tick naturally follows
 * it, with no separate "a new run started" detection needed. Once the
 * latest run reaches a terminal status, the job is auto-unsubscribed: the
 * agent asked to watch until done, it's done, so watching stops without
 * an explicit ci.unsubscribe call.
 *
 * Wired into the daemon as a maintenance task (see daemon.ts), so it runs
 * on its own schedule regardless of whether any client is connected right
 * now. One job's failed refresh must not abort the rest of the batch, so
 * each job is fetched and caught independently.
 */
import type { Logger } from "@danypops/vehicle-server/logging";
import type { Orchestrator } from "../orchestrator.ts";
import type { RunStatus } from "../run/ci-run.ts";
import { isTerminalStatus } from "../run/ci-run.ts";
import type { RunPool } from "../sqlite/run-pool.ts";

const NOOP_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export interface RunStatusTransition {
	backend: string;
	jobRef: string;
	runId: string;
	status: RunStatus;
	url: string;
}

export async function syncRunPool(
	orchestrator: Orchestrator,
	pool: RunPool,
	logger: Logger = NOOP_LOGGER,
	/** Called once per job whose fetched status differs from what the pool had previously recorded for that run -- e.g. wired to PushChannel.publish() so a subscribed client sees a live queued -> running -> success/failure transition instead of polling. Never called for an unchanged status (including the fresh-fetch tick that lands the same terminal status a second time). */
	onStatusChange?: (transition: RunStatusTransition) => void,
): Promise<void> {
	const jobs = pool.watchedJobs();
	await Promise.all(
		jobs.map(async ({ backend, jobRef }) => {
			try {
				const run = await orchestrator.ciGetRun(backend, jobRef, "latest");
				const log = await orchestrator.ciGetRawLog(backend, jobRef, run.id);
				const fetchedAt = new Date();
				const previous = pool.get(backend, jobRef, run.id);
				pool.upsert({
					backend,
					jobRef,
					runId: run.id,
					status: run.status,
					result: run.result ?? "",
					url: run.url ?? "",
					startedAt: run.startedAt,
					durationMs: run.durationMs,
					fetchedAt,
					watched: !isTerminalStatus(run.status),
				});
				pool.upsertLog(backend, jobRef, run.id, log);
				if (previous?.status !== run.status) {
					onStatusChange?.({ backend, jobRef, runId: run.id, status: run.status, url: run.url ?? "" });
				}

				if (isTerminalStatus(run.status)) pool.unsubscribeJob(backend, jobRef);
			} catch (error) {
				logger.warn("job pool sync failed for one job", {
					backend,
					jobRef,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}),
	);
}

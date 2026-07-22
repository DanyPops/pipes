/**
 * Background sync: refreshes every watched run's status through the real
 * orchestrator/adapter path and writes the result back to the local pool.
 * Wired into the daemon as a maintenance task (see daemon.ts), so it runs
 * on its own schedule regardless of whether any client is connected right
 * now — the same standalone-adapter shape agent-deck uses for Alef's
 * session data, applied here to CI run status instead.
 *
 * One run's failed refresh (backend down, run deleted, etc.) must not
 * abort the rest of the batch, so each row is fetched and caught
 * independently.
 */
import type { Logger } from "@danypops/daemon-kit/logging";
import type { Orchestrator } from "./orchestrator.ts";
import { isTerminalStatus, type RunPool } from "./run-pool.ts";

const NOOP_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export async function syncRunPool(orchestrator: Orchestrator, pool: RunPool, logger: Logger = NOOP_LOGGER): Promise<void> {
	const watched = pool.watchedRuns();
	await Promise.all(
		watched.map(async (snapshot) => {
			try {
				const run = await orchestrator.ciGetRun(snapshot.backend, snapshot.jobRef, snapshot.runId);
				pool.upsert({
					backend: snapshot.backend,
					jobRef: snapshot.jobRef,
					runId: snapshot.runId,
					status: run.status,
					result: run.result ?? "",
					url: run.url ?? "",
					startedAt: run.startedAt,
					durationMs: run.durationMs,
					fetchedAt: new Date(),
					watched: !isTerminalStatus(run.status),
				});
			} catch (error) {
				logger.warn("run pool sync failed for one run", {
					backend: snapshot.backend,
					jobRef: snapshot.jobRef,
					runId: snapshot.runId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}),
	);
}

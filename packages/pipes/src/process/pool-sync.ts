/**
 * Background sync: for every watched *job* (not a fixed run ID), resolves
 * whatever "latest" currently means for that job and refreshes its status
 * and full log through the real orchestrator/adapter path. Re-resolving
 * "latest" every tick is what gives autofocus for free -- if a new run
 * supersedes the one last observed, the very next tick naturally follows
 * it, with no separate "a new run started" detection needed. Once the
 * latest run reaches a terminal status, every subscriber on the job is
 * auto-unsubscribed: the run is done, a job-level fact no individual
 * subscriber's schedule should keep polling past.
 *
 * A job can have several independent subscriptions (one per subscriberId),
 * each with its own optional scheduleMs cadence. A job is fetched on a
 * given tick if ANY of its subscriptions is due (scheduleMs elapsed since
 * its own lastCheckedAt, or no scheduleMs at all -- due on every tick,
 * the original single-subscriber behavior). One live fetch serves every
 * subscriber attached to that job, so every attached subscription's
 * lastCheckedAt is stamped together, not just the one(s) that triggered it.
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
import type { JobSubscription, RunPool } from "../sqlite/run-pool.ts";

const NOOP_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export interface RunStatusTransition {
	backend: string;
	jobRef: string;
	runId: string;
	status: RunStatus;
	url: string;
}

/** True if this subscription's own cadence has elapsed since it was last checked -- always true for a subscription with no scheduleMs, matching the original every-tick behavior. */
function isDue(subscription: JobSubscription, nowMs: number): boolean {
	if (subscription.scheduleMs === undefined) return true;
	if (subscription.lastCheckedAt === undefined) return true;
	return nowMs - subscription.lastCheckedAt.getTime() >= subscription.scheduleMs;
}

export async function syncRunPool(
	orchestrator: Orchestrator,
	pool: RunPool,
	logger: Logger = NOOP_LOGGER,
	/** Called once per job whose fetched status differs from what the pool had previously recorded for that run -- e.g. wired to PushChannel.publish() so a subscribed client sees a live queued -> running -> success/failure transition instead of polling. Never called for an unchanged status (including the fresh-fetch tick that lands the same terminal status a second time). */
	onStatusChange?: (transition: RunStatusTransition) => void,
	/** Injected clock, mirroring orchestrator.ts's ciWatch -- lets tests assert due-time gating with literal fake timestamps instead of real sleeps. */
	now: () => number = Date.now,
): Promise<void> {
	const subscriptionsByJob = new Map<string, { backend: string; jobRef: string; subscriptions: JobSubscription[] }>();
	for (const subscription of pool.watchedSubscriptions()) {
		const key = `${subscription.backend}\u0000${subscription.jobRef}`;
		const existing = subscriptionsByJob.get(key);
		if (existing) existing.subscriptions.push(subscription);
		else subscriptionsByJob.set(key, { backend: subscription.backend, jobRef: subscription.jobRef, subscriptions: [subscription] });
	}

	const nowMs = now();
	const dueJobs = [...subscriptionsByJob.values()].filter((job) => job.subscriptions.some((s) => isDue(s, nowMs)));

	await Promise.all(
		dueJobs.map(async ({ backend, jobRef, subscriptions }) => {
			try {
				const run = await orchestrator.ciGetRun(backend, jobRef, "latest");
				const log = await orchestrator.ciGetRawLog(backend, jobRef, run.id);
				const fetchedAt = new Date(nowMs);
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

				if (isTerminalStatus(run.status)) {
					pool.unsubscribeAllForJob(backend, jobRef);
				} else {
					// The live fetch serves every subscriber attached to this job, whether or not
					// each one's own schedule was individually due -- everyone's view is fresh now.
					for (const subscription of subscriptions) pool.markSubscriptionChecked(backend, jobRef, subscription.subscriberId, fetchedAt);
				}
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

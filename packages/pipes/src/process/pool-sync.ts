/**
 * Background sync: for every watched subscription, resolves either "latest" for its job
 * (the default) or, if the subscription pinned itself to a specific runId, that exact run
 * forever -- pinning is the only safe way to track a run this session actually triggered on
 * a job other automation/users also trigger concurrently; re-resolving "latest" on a busy
 * shared job can silently jump onto someone else's unrelated build.
 *
 * Subscriptions are grouped by (backend, jobRef, targetRunId) -- "latest" for every unpinned
 * subscriber on a job is one group (autofocus: if a new run supersedes the last one observed,
 * the very next tick naturally follows it, no separate "a new run started" detection needed);
 * each distinct pinned runId on that same job is its own separate group, fetched and tracked
 * independently. One live fetch serves every subscription in its own group, so their
 * lastCheckedAt is stamped together. Once a group's target run reaches a terminal status,
 * only the subscriptions in *that* group are unsubscribed -- a pinned run finishing says
 * nothing about whether "latest" (or a different pinned run) on the same job is also done.
 *
 * A job can have several independent subscriptions (one per subscriberId), each with its own
 * optional scheduleMs cadence. A group is fetched on a given tick if ANY of its member
 * subscriptions is due (scheduleMs elapsed since its own lastCheckedAt, or no scheduleMs at
 * all -- due on every tick, the original single-subscriber behavior).
 *
 * Wired into the daemon as a maintenance task (see daemon.ts), so it runs
 * on its own schedule regardless of whether any client is connected right
 * now. One group's failed refresh must not abort the rest of the batch, so
 * each group is fetched and caught independently.
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

interface FetchGroup {
	backend: string;
	jobRef: string;
	/** The literal run id to fetch -- "latest" for every unpinned subscription's shared group, or the exact pinned run id for a pinned group. */
	targetRunId: string;
	subscriptions: JobSubscription[];
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
	const groupsByKey = new Map<string, FetchGroup>();
	for (const subscription of pool.watchedSubscriptions()) {
		const targetRunId = subscription.pinnedRunId ?? "latest";
		const key = `${subscription.backend}\u0000${subscription.jobRef}\u0000${targetRunId}`;
		const existing = groupsByKey.get(key);
		if (existing) existing.subscriptions.push(subscription);
		else groupsByKey.set(key, { backend: subscription.backend, jobRef: subscription.jobRef, targetRunId, subscriptions: [subscription] });
	}

	const nowMs = now();
	const dueGroups = [...groupsByKey.values()].filter((group) => group.subscriptions.some((s) => isDue(s, nowMs)));

	await Promise.all(
		dueGroups.map(async ({ backend, jobRef, targetRunId, subscriptions }) => {
			try {
				const run = await orchestrator.ciGetRun(backend, jobRef, targetRunId);
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
					// Only this group's own subscriptions -- a pinned run (or "latest") finishing says
					// nothing about whether a different pinned run, or "latest" itself, is also done.
					for (const subscription of subscriptions) pool.unsubscribeJob(backend, jobRef, subscription.subscriberId);
				} else {
					// The live fetch serves every subscription in this group, whether or not each
					// one's own schedule was individually due -- everyone's view is fresh now.
					for (const subscription of subscriptions) pool.markSubscriptionChecked(backend, jobRef, subscription.subscriberId, fetchedAt);
				}
			} catch (error) {
				logger.warn("job pool sync failed for one group", {
					backend,
					jobRef,
					targetRunId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}),
	);
}

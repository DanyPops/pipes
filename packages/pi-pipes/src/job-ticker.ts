/**
 * The pure decision step behind "wire the job overlay to notify the agent": given each refresh's
 * freshly fetched subscribed-job rows, decides whether this tick is worth interrupting the agent
 * for, and returns the message text to send (or undefined). No I/O, no ExtensionAPI, no timers --
 * mirrors jobs-widget.ts's own pure-projection split. See jobs-overlay.ts for the stateful class
 * that actually calls pi.sendUserMessage with whatever this returns.
 *
 * Two distinct triggers, in priority order:
 *  1. A previously-tracked job disappearing from ci.subscribed's own watched set -- the daemon's
 *     background sync (packages/pipes' pool-sync.ts) already flips a run's `watched` flag to false
 *     the moment it observes a terminal status, so "vanished since the last successful fetch" is
 *     the only terminal-transition signal this RPC surface gives pi-pipes today. Reported
 *     immediately, regardless of how little time has passed -- a completion is a one-shot event,
 *     never throttled.
 *  2. A slow, throttled "still in flight" reminder for whatever remains subscribed, so a long-
 *     running job periodically prompts the agent to check in rather than only ever being
 *     mentioned once at subscribe time. Never fires on the very first tick (no reminder is due
 *     immediately after subscribing to something the agent already knows about), and never twice
 *     within reminderIntervalMs of each other.
 *
 * Deliberately asks the agent to go probe rather than embedding the job's last-seen status/result
 * itself -- ci.subscribed's own watched-only view can't give an accurate terminal result (the row
 * is already gone by the time it's terminal), and probing directly (ci_status/ci_pool/ci_wait) is
 * cheap and already exactly what the agent would otherwise do next.
 */
import type { JobsWidgetRow } from "./jobs-widget.ts";

const DEFAULT_REMINDER_INTERVAL_MS = 5 * 60_000;

function rowKey(row: Pick<JobsWidgetRow, "backend" | "jobRef" | "runId">): string {
	return `${row.backend}/${row.jobRef}/${row.runId}`;
}

export function resolveJobTickerReminderIntervalMs(value: string | undefined = process.env.PIPES_JOB_TICKER_REMINDER_MS): number {
	const parsed = value ? Number(value) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REMINDER_INTERVAL_MS;
}

export interface JobTickerOptions {
	/** Minimum real-world gap between two "still in flight" reminders. Defaults to
	 * resolveJobTickerReminderIntervalMs() (5 minutes, overridable via PIPES_JOB_TICKER_REMINDER_MS). */
	reminderIntervalMs?: number;
	/** Injectable clock for deterministic tests. Defaults to Date.now. */
	now?: () => number;
}

export class JobTicker {
	private previousKeys = new Set<string>();
	private lastReminderAt: number;
	private readonly reminderIntervalMs: number;
	private readonly now: () => number;

	constructor(options: JobTickerOptions = {}) {
		this.reminderIntervalMs = options.reminderIntervalMs ?? resolveJobTickerReminderIntervalMs();
		this.now = options.now ?? Date.now;
		// Starts the reminder clock at construction, not epoch zero -- so a job just subscribed to
		// (which the agent already knows about) doesn't immediately trigger a redundant reminder on
		// this ticker's very first tick.
		this.lastReminderAt = this.now();
	}

	/**
	 * Call at most once per real, successful refresh, in poll order. Mutates this ticker's own
	 * transition/throttle state as a side effect of being told about this tick -- a failed fetch
	 * must never be fed here (see jobs-overlay.ts's own refresh()): an empty result from a daemon
	 * hiccup would otherwise read as every subscribed job having just finished.
	 */
	tick(rows: readonly JobsWidgetRow[]): string | undefined {
		const currentKeys = new Set(rows.map(rowKey));
		const vanished = [...this.previousKeys].filter((key) => !currentKeys.has(key));
		this.previousKeys = currentKeys;

		if (vanished.length > 0) return buildVanishedMessage(vanished);
		if (rows.length === 0) return undefined;

		const now = this.now();
		if (now - this.lastReminderAt < this.reminderIntervalMs) return undefined;
		this.lastReminderAt = now;
		return buildStillRunningMessage(rows);
	}
}

function buildVanishedMessage(vanishedKeys: string[]): string {
	const plural = vanishedKeys.length === 1 ? "job is" : "jobs are";
	return (
		`[pi-pipes] ${vanishedKeys.length} subscribed CI ${plural} no longer being tracked -- ` +
		`${vanishedKeys.join(", ")} likely just finished. Probe its current status/result ` +
		`(e.g. ci_status or ci_pool) if that's relevant to what you're doing.`
	);
}

function buildStillRunningMessage(rows: readonly JobsWidgetRow[]): string {
	const plural = rows.length === 1 ? "job is" : "jobs are";
	const keys = rows.map(rowKey).join(", ");
	return `[pi-pipes] ${rows.length} subscribed CI ${plural} still in flight: ${keys}. If you're waiting on one of these, probe its current progress.`;
}

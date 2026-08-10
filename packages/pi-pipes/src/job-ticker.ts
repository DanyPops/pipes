/**
 * pi-pipes' own domain config over @danypops/vehicle-client-pi's generic AgentPollTicker
 * (see its own `agent-poll-ticker` module) -- the vanish/reminder decision logic itself, and its
 * own exhaustive tests, now live there. Extracted from this file's prior hand-rolled version once
 * pi-papyrus turned out to have independently hand-rolled the same "notify the agent about
 * background state, not just a widget" problem (ActiveTaskContinuation).
 *
 * What's left here is only what's genuinely pi-pipes-specific: a CI job row's own identity key
 * (backend/jobRef/runId), and message wording that deliberately asks the agent to go probe
 * (ci_status/ci_pool/ci_wait) rather than embedding a guessed status/result itself -- ci.subscribed's
 * own watched-only view can't give an accurate terminal result (the row is already gone by the time
 * it's terminal, since packages/pipes' pool-sync.ts flips `watched` to false the moment it observes
 * one), and probing directly is cheap and already exactly what the agent would otherwise do next.
 */
import { AgentPollTicker } from "@danypops/vehicle-client-pi/agent-poll-ticker";
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

/** Builds a ticker configured for CI job rows. See jobs-overlay.ts for where its tick() result is
 * actually delivered to the agent, via @danypops/vehicle-client-pi's own reportAgentPollTick. */
export function createJobTicker(options: JobTickerOptions = {}): AgentPollTicker<JobsWidgetRow> {
	return new AgentPollTicker<JobsWidgetRow>({
		key: rowKey,
		buildVanishedMessage,
		buildReminderMessage: buildStillRunningMessage,
		reminderIntervalMs: options.reminderIntervalMs ?? resolveJobTickerReminderIntervalMs(),
		now: options.now,
	});
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

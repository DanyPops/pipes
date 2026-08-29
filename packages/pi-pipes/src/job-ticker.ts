import { frameAsBackgroundNotification } from "@danypops/vehicle-client-pi/agent-poll-ticker";
import type { JobsWidgetRow } from "./jobs-widget.ts";

const DEFAULT_REMINDER_INTERVAL_MS = 5 * 60_000;
const MAX_COMPLETIONS_PER_TICK = 20;
const MAX_REPORTED_COMPLETIONS = 1_000;

function rowKey(row: Pick<JobsWidgetRow, "backend" | "jobRef" | "runId">): string {
	return `${row.backend}/${row.jobRef}/${row.runId}`;
}

export function resolveJobTickerReminderIntervalMs(value: string | undefined = process.env.PIPES_JOB_TICKER_REMINDER_MS): number {
	const parsed = value ? Number(value) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REMINDER_INTERVAL_MS;
}

/** Carries one session-authorized CI run's terminal outcome. */
export interface JobCompletion {
	backend: string;
	jobRef: string;
	runId: string;
	status: string;
	result?: string;
	url?: string;
	failureClassification?: string;
}

/** Describes a bounded agent notification and whether it should wake an idle agent. */
export interface JobTickerNotice {
	content: string;
	triggerTurn: boolean;
}

/** Configures reminder cadence and deterministic time for a job ticker. */
export interface JobTickerOptions {
	reminderIntervalMs?: number;
	now?: () => number;
}

/** Resolves the exact terminal outcome for a previously tracked job. */
export type JobCompletionResolver = (row: JobsWidgetRow) => Promise<JobCompletion>;

/** Tracks subscribed jobs, deduplicates completions, and bounds reminder delivery. */
export class JobTicker {
	private previousRows = new Map<string, JobsWidgetRow>();
	private readonly reportedKeys = new Set<string>();
	private readonly reportedOrder: string[] = [];
	private lastReminderAt: number;
	private readonly reminderIntervalMs: number;
	private readonly now: () => number;

	constructor(options: JobTickerOptions = {}) {
		this.reminderIntervalMs = options.reminderIntervalMs ?? resolveJobTickerReminderIntervalMs();
		this.now = options.now ?? Date.now;
		this.lastReminderAt = this.now();
	}

	async tick(rows: readonly JobsWidgetRow[], resolveCompletion: JobCompletionResolver): Promise<JobTickerNotice | undefined> {
		const currentRows = new Map(rows.map((row) => [rowKey(row), row]));
		const vanished = [...this.previousRows.entries()].filter(([key]) => !currentRows.has(key) && !this.reportedKeys.has(key));

		if (vanished.length > 0) {
			const selected = vanished.slice(0, MAX_COMPLETIONS_PER_TICK);
			const resolved = await Promise.all(
				selected.map(async ([key, row]) => {
					try {
						return { key, completion: await resolveCompletion(row) };
					} catch {
						currentRows.set(key, row);
						return undefined;
					}
				}),
			);
			for (const [key, row] of vanished.slice(MAX_COMPLETIONS_PER_TICK)) currentRows.set(key, row);
			const completions = resolved.flatMap((entry) => {
				if (!entry) return [];
				this.markReported(entry.key);
				return [entry.completion];
			});
			this.previousRows = currentRows;
			if (completions.length === 0) return undefined;
			return {
				content: buildCompletionMessage(completions, vanished.length > selected.length),
				triggerTurn: true,
			};
		}

		this.previousRows = currentRows;
		if (rows.length === 0) return undefined;
		const now = this.now();
		if (now - this.lastReminderAt < this.reminderIntervalMs) return undefined;
		this.lastReminderAt = now;
		return { content: buildStillRunningMessage(rows), triggerTurn: false };
	}

	completion(completion: JobCompletion): JobTickerNotice | undefined {
		const key = rowKey(completion);
		if (this.reportedKeys.has(key)) return undefined;
		this.markReported(key);
		this.previousRows.delete(key);
		return { content: buildCompletionMessage([completion], false), triggerTurn: true };
	}

	private markReported(key: string): void {
		if (this.reportedKeys.has(key)) return;
		this.reportedKeys.add(key);
		this.reportedOrder.push(key);
		if (this.reportedOrder.length <= MAX_REPORTED_COMPLETIONS) return;
		const oldest = this.reportedOrder.shift();
		if (oldest) this.reportedKeys.delete(oldest);
	}
}

/** Creates a session-local ticker for subscribed CI jobs. */
export function createJobTicker(options: JobTickerOptions = {}): JobTicker {
	return new JobTicker(options);
}

function buildCompletionMessage(completions: readonly JobCompletion[], truncated: boolean): string {
	const lines = completions.map((completion) => {
		const identity = rowKey(completion);
		const result = completion.result && completion.result !== completion.status ? ` (${completion.result})` : "";
		const classification = completion.failureClassification ? `; classification: ${completion.failureClassification}` : "";
		const url = completion.url ? `; ${completion.url}` : "";
		return `- ${identity}: ${completion.status}${result}${classification}${url}`;
	});
	if (truncated) lines.push(`- additional completions omitted after ${MAX_COMPLETIONS_PER_TICK}`);
	return frameAsBackgroundNotification(`[pi-pipes] Subscribed CI completion:\n${lines.join("\n")}`);
}

function buildStillRunningMessage(rows: readonly JobsWidgetRow[]): string {
	const plural = rows.length === 1 ? "job is" : "jobs are";
	const keys = rows.map(rowKey).join(", ");
	return frameAsBackgroundNotification(
		`[pi-pipes] ${rows.length} subscribed CI ${plural} still in flight: ${keys}. If you're waiting on one of these, probe its current progress.`,
	);
}

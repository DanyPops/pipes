/**
 * The subscribed-jobs widget's own daemon connector -- deliberately `connectPipesClient`, never
 * `createPipesClient`: the latter can spawn the daemon (EnsureDaemonOptions), which is fine for an
 * explicit, human-triggered `/pipes` command (see pipes-tui.ts) but wrong for a passive background
 * poll a session never asked to start anything -- the same "never spawn passively" rule
 * vehicle-client.ts's own registerPipesVehicle already follows for tool registration.
 * connectPipesClient throws when the daemon isn't already running; fetchSubscribedJobs lets that
 * propagate -- JobsOverlay.refresh() is what degrades it to "nothing subscribed right now".
 */
import { connectPipesClient, type PipesClient } from "@danypops/pipes";
import type { JobCompletion } from "./job-ticker.ts";
import type { JobsWidgetRow } from "./jobs-widget.ts";

export type JobsClientConnector = () => PipesClient;

let connector: JobsClientConnector = () => connectPipesClient();
const TERMINAL_STATUSES = new Set(["success", "failure", "cancelled"]);

export function setJobsClientConnectorForTests(value: JobsClientConnector): void {
	connector = value;
}

export function resetJobsClientConnectorForTests(): void {
	connector = () => connectPipesClient();
}

/** Uses one authenticated daemon client for a complete widget refresh transaction. */
export interface JobsClientSession {
	fetchSubscribedJobs(subscriberId?: string): Promise<JobsWidgetRow[]>;
	fetchJobCompletion(row: JobsWidgetRow): Promise<JobCompletion>;
}

/** Captures one authenticated client for a complete refresh and any terminal lookup it causes. */
export function createJobsClientSession(): JobsClientSession {
	const client = connector();
	return {
		async fetchSubscribedJobs(subscriberId?: string): Promise<JobsWidgetRow[]> {
			const { runs } = await client.call("ci.subscribed", subscriberId === undefined ? {} : { subscriberId });
			return runs.map((run) => ({
				backend: run.backend,
				jobRef: run.jobRef,
				runId: run.runId,
				status: run.status,
				url: run.url || undefined,
				progressPercent: run.progressPercent,
				overdue: run.overdue,
				projectName: run.projectName,
				startedAt: run.startedAt ? new Date(run.startedAt) : undefined,
				durationMs: run.durationMs,
			}));
		},
		fetchJobCompletion: (row) => fetchJobCompletionWithClient(client, row),
	};
}

export async function fetchSubscribedJobs(subscriberId?: string): Promise<JobsWidgetRow[]> {
	return createJobsClientSession().fetchSubscribedJobs(subscriberId);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** Resolves the exact terminal verdict for a run that disappeared from ci.subscribed. */
export async function fetchJobCompletion(row: JobsWidgetRow): Promise<JobCompletion> {
	return fetchJobCompletionWithClient(connector(), row);
}

async function fetchJobCompletionWithClient(client: PipesClient, row: JobsWidgetRow): Promise<JobCompletion> {
	const output = await client.call("ci.status", { backend: row.backend, jobRef: row.jobRef, runId: row.runId });
	const verdict = record(output.verdict);
	const check = record(verdict?.check);
	if (!check || typeof check.status !== "string") throw new Error("ci.status returned no run verdict");
	const failure = record(verdict?.failure);
	return {
		backend: row.backend,
		jobRef: row.jobRef,
		runId: row.runId,
		status: check.status,
		url: typeof check.url === "string" ? check.url : row.url,
		failureClassification: typeof failure?.classification === "string" ? failure.classification : undefined,
	};
}

/** Validates and session-scopes one daemon `ci` push transition. */
export function parseJobCompletionTransition(payload: unknown, subscriberId: string): JobCompletion | undefined {
	const transition = record(payload);
	if (!transition) return undefined;
	const subscriberIds = Array.isArray(transition.subscriberIds)
		? transition.subscriberIds.filter((value): value is string => typeof value === "string")
		: [];
	if (!subscriberIds.includes(subscriberId)) return undefined;
	if (
		typeof transition.backend !== "string" ||
		typeof transition.jobRef !== "string" ||
		typeof transition.runId !== "string" ||
		typeof transition.status !== "string" ||
		!TERMINAL_STATUSES.has(transition.status)
	) {
		return undefined;
	}
	return {
		backend: transition.backend,
		jobRef: transition.jobRef,
		runId: transition.runId,
		status: transition.status,
		result: typeof transition.result === "string" ? transition.result : undefined,
		url: typeof transition.url === "string" ? transition.url : undefined,
	};
}

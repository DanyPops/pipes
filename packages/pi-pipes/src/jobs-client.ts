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
import type { JobsWidgetRow } from "./jobs-widget.ts";

export type JobsClientConnector = () => PipesClient;

let connector: JobsClientConnector = () => connectPipesClient();

export function setJobsClientConnectorForTests(value: JobsClientConnector): void {
	connector = value;
}

export function resetJobsClientConnectorForTests(): void {
	connector = () => connectPipesClient();
}

/** ci.subscribed's own RunSnapshot-shaped runs, narrowed to exactly what the widget renders --
 * pi-pipes never imports packages/pipes' domain types directly (same boundary ci-render.ts already
 * keeps for every other tool result). */
export async function fetchSubscribedJobs(): Promise<JobsWidgetRow[]> {
	const client = connector();
	const { runs } = await client.call("ci.subscribed", {});
	return runs.map((run) => ({
		backend: run.backend,
		jobRef: run.jobRef,
		runId: run.runId,
		status: run.status,
		url: run.url || undefined,
		progressPercent: run.progressPercent,
		overdue: run.overdue,
	}));
}

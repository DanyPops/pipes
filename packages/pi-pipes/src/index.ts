/**
 * pi-pipes: exposes the Pipes daemon (GitHub Actions, GitLab CI, Jenkins,
 * Prow) two ways: real per-operation Pi tools (ci_status, ci_trigger,
 * ci_wait, ...) projected from the daemon's own VehicleRegistry (see
 * vehicle-client.ts and @danypops/pipes' src/vehicle/pipes-vehicle.ts), and
 * a `/pipes` interactive TUI for the human (see pipes-tui.ts). Thin
 * authenticated client to @danypops/pipes — no network access or
 * credentials of its own.
 */

import { createPipesClient } from "@danypops/pipes";
import { registerSharedSecretsCommand } from "@danypops/vehicle-client-pi/secrets-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { JobsOverlay } from "./jobs-overlay.ts";
import { runPipesCommand } from "./pipes-tui.ts";
import { buildPipesSecretsBackends } from "./secrets.ts";
import { registerPipesVehicle, resolvePipesProgressBarStyle } from "./vehicle-client.ts";

export interface PiPipesDeps {
	/** Overridden in tests instead of exercising the real (daemon-talking) registerPipesVehicle. */
	registerVehicle?: typeof registerPipesVehicle;
}

export default async function pipesExtension(pi: ExtensionAPI, deps: PiPipesDeps = {}) {
	const registerVehicle = deps.registerVehicle ?? registerPipesVehicle;

	pi.registerCommand("pipes", {
		description: "Cross-platform CI: GitHub Actions, GitLab CI, Jenkins, Prow — trigger, cancel, view logs, manage presets",
		handler: async (_args, ctx) => runPipesCommand(ctx, createPipesClient),
	});

	// Contributes to the shared /secrets namespace (vehicle-client-pi's
	// registerSharedSecretsCommand) instead of a menu entry buried inside
	// /pipes -- pi-enigma and pi-tickets contribute the same way, so
	// whichever of the three loads first in a given Pi session ends up
	// claiming the real command registration, and all three still show up
	// in it regardless of load order.
	registerSharedSecretsCommand(pi, { source: "pipes", resolve: () => ({ backends: buildPipesSecretsBackends() }) });

	// Persistent "Jobs · N subscribed" widget above the editor, mirroring pi-papyrus's own
	// TaskOverlay/NoteOverlay pattern -- see jobs-overlay.ts. Poll-only (no push channel wired up
	// for "ci" yet); never spawns the daemon (jobs-client.ts's fetchSubscribedJobs uses
	// connectPipesClient, not createPipesClient), so a session with the daemon not running just
	// shows nothing instead of starting one for a passive background widget.
	let jobsOverlay: JobsOverlay | undefined;
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		jobsOverlay ??= new JobsOverlay(resolvePipesProgressBarStyle());
		jobsOverlay.setUI(ctx.ui);
		await jobsOverlay.refresh();
		jobsOverlay.startPolling();
	});
	pi.on("session_shutdown", async () => {
		jobsOverlay?.dispose();
	});

	// Pi awaits async extension factories before replaying the transcript, so
	// Vehicle renderers must be registered here rather than in session_start.
	await registerVehicle(pi);
}

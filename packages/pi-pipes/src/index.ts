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
import { runPipesCommand } from "./pipes-tui.ts";
import { buildPipesSecretsBackends } from "./secrets.ts";
import { registerPipesVehicle } from "./vehicle-client.ts";

export interface PiPipesDeps {
	/** Overridden in tests instead of exercising the real (daemon-talking) registerPipesVehicle. */
	registerVehicle?: typeof registerPipesVehicle;
}

export default function pipesExtension(pi: ExtensionAPI, deps: PiPipesDeps = {}) {
	const registerVehicle = deps.registerVehicle ?? registerPipesVehicle;
	// registerVehicleTools() (which registerPipesVehicle wraps) needs
	// pi.getAllTools()/getActiveTools()/setActiveTools() -- Pi's extension
	// runtime only finishes initializing after every extension's top-level
	// factory (this one included) has resolved, so calling it directly from
	// here throws "Extension runtime not initialized". session_start fires
	// only after that initialization completes.
	pi.on("session_start", async () => {
		await registerVehicle(pi);
	});

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
}

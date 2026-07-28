/**
 * pi-pipes: TUI menu for cross-platform CI (GitHub Actions, GitLab CI,
 * Jenkins, Prow). Thin authenticated client to @danypops/pipes —
 * no network access or credentials of its own.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSharedSecretsCommand } from "@danypops/daemon-kit/secrets-tui";
import { registerCiTool } from "./ci-tool.ts";
import { connectOrStartPipesClient } from "./daemon-client.ts";
import { runPipesCommand } from "./pipes-tui.ts";
import { buildPipesSecretsBackends } from "./secrets.ts";

export default function pipesExtension(pi: ExtensionAPI) {
	registerCiTool(pi);

	pi.registerCommand("pipes", {
		description: "Cross-platform CI: GitHub Actions, GitLab CI, Jenkins, Prow — trigger, cancel, view logs, manage presets",
		handler: async (_args, ctx) => runPipesCommand(ctx, connectOrStartPipesClient),
	});

	// Contributes to the shared /secrets namespace (daemon-kit's
	// registerSharedSecretsCommand) instead of a menu entry buried inside
	// /pipes -- pi-enigma and pi-tickets contribute the same way, so
	// whichever of the three loads first in a given Pi session ends up
	// claiming the real command registration, and all three still show up
	// in it regardless of load order.
	registerSharedSecretsCommand(pi, { source: "pipes", resolve: () => ({ backends: buildPipesSecretsBackends() }) });
}

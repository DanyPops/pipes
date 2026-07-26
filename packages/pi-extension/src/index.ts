/**
 * pi-pipes: TUI menu for cross-platform CI (GitHub Actions, GitLab CI,
 * Jenkins, Prow). Thin authenticated client to @danypops/pipes —
 * no network access or credentials of its own.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCiTool } from "./ci-tool.ts";
import { connectOrStartPipesClient } from "./daemon-client.ts";
import { runPipesCommand } from "./pipes-tui.ts";

export default function pipesExtension(pi: ExtensionAPI) {
	registerCiTool(pi);

	pi.registerCommand("pipes", {
		description: "Cross-platform CI: GitHub Actions, GitLab CI, Jenkins, Prow — trigger, cancel, view logs, manage presets",
		handler: async (_args, ctx) => runPipesCommand(ctx, connectOrStartPipesClient),
	});
}

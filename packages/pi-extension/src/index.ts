/**
 * pi-pipes: TUI menu for cross-platform CI (GitHub Actions, GitLab CI,
 * Jenkins, Prow). Thin authenticated client to @danypops/pipes-daemon —
 * no network access or credentials of its own.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCiTool } from "./ci-tool.ts";
import { connectOrStartPipesClient } from "./daemon-client.ts";

interface BackendInfo {
	name: string;
	type: string;
	capabilities?: string;
}

export default function pipesExtension(pi: ExtensionAPI) {
	registerCiTool(pi);

	pi.registerCommand("pipes", {
		description: "Cross-platform CI: GitHub Actions, GitLab CI, Jenkins, Prow",
		handler: async (_args, ctx) => {
			try {
				const client = await connectOrStartPipesClient();
				const health = await client.health();
				const { backends, pipelines } = await client.call<{ backends: BackendInfo[]; pipelines: string[] }>("ci.help", {});
				const backendSummary = backends.length > 0 ? backends.map((b) => b.name).join(", ") : "none registered yet";
				const pipelineSummary = pipelines.length > 0 ? pipelines.join(", ") : "none defined yet";
				ctx.ui.notify(`Pipes daemon v${health.version} — backends: ${backendSummary}; presets: ${pipelineSummary}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`pi-pipes: ${message}`, "error");
			}
		},
	});
}

/**
 * pi-pipes: TUI menu for cross-platform CI (GitHub Actions, GitLab CI,
 * Jenkins, Prow). Thin authenticated client to @danypops/pipes-daemon —
 * no network access or credentials of its own.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectOrStartPipesClient } from "./daemon-client.ts";

export default function pipesExtension(pi: ExtensionAPI) {
	pi.registerCommand("pipes", {
		description: "Cross-platform CI: GitHub Actions, GitLab CI, Jenkins, Prow",
		handler: async (_args, ctx) => {
			try {
				const client = await connectOrStartPipesClient();
				const health = await client.health();
				const { backends } = await client.call<{ backends: string[] }>("backends.list", {});
				const backendSummary = backends.length > 0 ? backends.join(", ") : "none registered yet";
				ctx.ui.notify(`Pipes daemon v${health.version} — backends: ${backendSummary}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`pi-pipes: ${message}`, "error");
			}
		},
	});
}

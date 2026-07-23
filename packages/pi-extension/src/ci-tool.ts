/**
 * The primary agent-facing surface: one tool over pipes-daemon's ci.*
 * operations, mirroring conty's single MCP `ci` tool (one action enum over
 * a shared schema, rather than one tool per operation).
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { connectOrStartPipesClient } from "./daemon-client.ts";

const ACTIONS = ["help", "status", "log", "search", "trigger", "wait", "cancel", "stages", "chain", "pool", "subscribe", "unsubscribe", "tail"] as const;

const PARAMETERS = Type.Object({
	action: StringEnum(ACTIONS, { description: "Action to perform. Call help first to see configured backends and presets." }),
	backend: Type.Optional(Type.String({ description: "Backend name, as listed by help. Omit when pipeline is set." })),
	jobRef: Type.Optional(Type.String({ description: "Job path, e.g. a GitHub workflow file, a GitLab job name, or a Jenkins folder path." })),
	runId: Type.Optional(Type.String({ description: "Build/run number. Optional for status/log — omit to use the latest run." })),
	opaqueRef: Type.Optional(Type.String({ description: "Opaque trigger reference returned by trigger. Pass to wait to resolve to a run ID without watching." })),
	pipeline: Type.Optional(Type.String({ description: "Named preset. Use instead of backend+jobRef for trigger/status/log." })),
	step: Type.Optional(Type.Integer({ description: "Step index for pipeline log (0-based). Use with pipeline." })),
	params: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Build parameters for trigger, or an exact-match parameter filter for search." })),
	result: Type.Optional(Type.String({ description: "Filter by result for search: SUCCESS, FAILURE, ABORTED." })),
	runner: Type.Optional(Type.String({ description: "Filter by triggering user for search." })),
	since: Type.Optional(Type.String({ description: "RFC3339 lower bound on run start time for search." })),
	limit: Type.Optional(Type.Integer({ description: "Max results for search." })),
	tail: Type.Optional(Type.Integer({ description: "Lines from the end of a log (default 200, -1 = all). Applies to status and log." })),
	grep: Type.Optional(Type.String({ description: "Return only log lines containing this (regexp, case-insensitive). Applies to status and log." })),
	includeParams: Type.Optional(Type.Boolean({ description: "For status: also return the run's build parameters." })),
	timeoutS: Type.Optional(Type.Integer({ description: "Blocking timeout in seconds for wait (default 3600)." })),
	steps: Type.Optional(Type.Boolean({ description: "For stages: expand to step-level detail instead of a flat stage list." })),
	includeFailedLog: Type.Optional(Type.Boolean({ description: "For stages: attach each failed step's log (requires steps=true)." })),
	depth: Type.Optional(Type.Integer({ description: "Max recursion depth for chain (default 3, -1 = unlimited)." })),
	artifacts: Type.Optional(Type.Boolean({ description: "For chain: attach each node's artifact list." })),
	maxTokens: Type.Optional(Type.Integer({ description: "For tail: token budget for the returned log excerpt (default 2000). The full log is always cached server-side regardless of this." })),
});

function operationFor(action: (typeof ACTIONS)[number]): string {
	return action === "help" ? "ci.help" : `ci.${action}`;
}

export function registerCiTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ci",
		label: "CI",
		description:
			"Cross-platform CI operations (GitHub Actions, GitLab CI, Jenkins, Prow) without hand-rolling each backend's API. " +
			"Call ci(action=help) first — lists configured backends and named presets. " +
			"Typical flow: trigger -> wait -> status. status(grep=error) gives a verdict plus filtered failure log in one call. " +
			"runId is optional for status/log — omit it to use the latest run. wait is blocking: it polls until the run finishes " +
			"or timeoutS elapses, so you don't need to re-poll manually.",
		promptSnippet: "Trigger, watch, and check results for CI pipelines across GitHub/GitLab/Jenkins/Prow",
		promptGuidelines: [
			"Use ci(action=help) before assuming which backends or presets are configured.",
			"Use ci(action=trigger) then ci(action=wait) then ci(action=status) for a full deploy-and-diagnose flow, instead of ad-hoc polling.",
			"Use ci(action=status, grep=...) to get a failure's classified cause and log excerpt in one call rather than separately fetching the full log.",
			"Use ci(action=pool) for a cheap, frequent status check on a run you already triggered — it reads the daemon's locally pooled history and never calls the live backend, unlike status/search.",
			"Use ci(action=subscribe, backend=..., jobRef=...) to have the daemon keep following a job's latest run in the background — it auto-refocuses onto a new run if one supersedes the last, and auto-unsubscribes once that latest run finishes, so no cleanup call is needed. trigger already subscribes automatically.",
			"Use ci(action=tail, backend=..., jobRef=...) to check a subscribed job's most recent log output — it returns a token-budgeted excerpt of the full cached log, not the whole thing, so repeated polling doesn't flood context.",
		],
		parameters: PARAMETERS,
		async execute(_toolCallId, params) {
			const { action, ...rest } = params as { action: (typeof ACTIONS)[number] } & Record<string, unknown>;
			const client = await connectOrStartPipesClient();
			const result = await client.call(operationFor(action), rest);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
		},
	});
}

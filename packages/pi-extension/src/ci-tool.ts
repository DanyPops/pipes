/**
 * The primary agent-facing surface: one tool over pipes's ci.*
 * operations, mirroring conty's single MCP `ci` tool (one action enum over
 * a shared schema, rather than one tool per operation).
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { findFirstUrl, openLine, statusGlyph } from "./ci-render.ts";
import { waitAndStreamTail } from "./ci-wait-stream.ts";
import { connectOrStartPipesClient } from "./daemon-client.ts";

const ACTIONS = ["help", "status", "log", "search", "trigger", "wait", "cancel", "stages", "chain", "pool", "subscribe", "unsubscribe", "tail", "downstream"] as const;

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
	maxTokens: Type.Optional(Type.Integer({ description: "For tail, and for wait's streamed log preview: token budget for the returned log excerpt (default 2000). The full log is always cached server-side regardless of this." })),
	downstreamJob: Type.Optional(Type.String({ description: "For downstream: the specific downstream job name to check (required for Jenkins; ignored by GitLab, whose bridges are scoped to the pipeline already given by upstreamRunId)." })),
	upstreamJob: Type.Optional(Type.String({ description: "For downstream: the upstream job name that triggered it." })),
	upstreamRunId: Type.Optional(Type.String({ description: "For downstream: the specific upstream run ID to match against." })),
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
			"or timeoutS elapses, so you don't need to re-poll manually. When jobRef+runId are given (watching an existing run, " +
			"not resolving an opaqueRef), wait streams a live log tail preview as it polls, instead of going silent until done.",
		promptSnippet: "Trigger, watch, and check results for CI pipelines across GitHub/GitLab/Jenkins/Prow",
		promptGuidelines: [
			"Use ci(action=help) before assuming which backends or presets are configured.",
			"Use ci(action=trigger) then ci(action=wait) then ci(action=status) for a full deploy-and-diagnose flow, instead of ad-hoc polling.",
			"Use ci(action=status, grep=...) to get a failure's classified cause and log excerpt in one call rather than separately fetching the full log.",
			"Use ci(action=pool) for a cheap, frequent status check on a run you already triggered — it reads the daemon's locally pooled history and never calls the live backend, unlike status/search.",
			"Use ci(action=subscribe, backend=..., jobRef=...) to have the daemon keep following a job's latest run in the background — it auto-refocuses onto a new run if one supersedes the last, and auto-unsubscribes once that latest run finishes, so no cleanup call is needed. trigger already subscribes automatically.",
			"Use ci(action=tail, backend=..., jobRef=...) to check a subscribed job's most recent log output — it returns a token-budgeted excerpt of the full cached log, not the whole thing, so repeated polling doesn't flood context.",
			"Use ci(action=chain) for a run's downstream tree automatically where the backend supports it (GitLab). For Jenkins, ci(action=chain) alone will not find children -- use ci(action=downstream, downstreamJob=..., upstreamJob=..., upstreamRunId=...) with the specific downstream job name you're checking.",
		],
		parameters: PARAMETERS,
		async execute(_toolCallId, params, signal, onUpdate) {
			const { action, ...rest } = params as { action: (typeof ACTIONS)[number] } & Record<string, unknown>;
			const client = await connectOrStartPipesClient();

			// wait streams a live tail preview only for the "watch an existing run" form (jobRef+runId).
			// The opaqueRef-resolve form has no run to tail yet, and a jobRef with no runId is an invalid
			// combination the daemon itself rejects -- both fall through to the plain single-call path
			// below so the daemon's own validation error surfaces unchanged.
			if (action === "wait" && !rest.opaqueRef && typeof rest.backend === "string" && typeof rest.jobRef === "string" && typeof rest.runId === "string") {
				const result = await waitAndStreamTail(
					client,
					{ backend: rest.backend, jobRef: rest.jobRef, runId: rest.runId, timeoutS: rest.timeoutS as number | undefined, maxTokens: rest.maxTokens as number | undefined },
					onUpdate,
					signal,
				);
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: { result } };
			}

			const result = await client.call(operationFor(action), rest);
			// content is the LLM-facing channel (complete, exact JSON); details carries the same
			// structured result for renderResult's separate human-facing TUI channel below.
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: { result } };
		},

		renderCall(args, theme, _context) {
			const input = args as { action?: string; backend?: string; jobRef?: string; pipeline?: string; runId?: string };
			let text = theme.fg("toolTitle", theme.bold("ci ")) + theme.fg("muted", input.action ?? "");
			if (input.pipeline) {
				text += " " + theme.fg("accent", input.pipeline);
			} else {
				const target = [input.backend, input.jobRef].filter(Boolean).join("/");
				if (target) text += " " + theme.fg("accent", target);
			}
			if (input.runId) text += " " + theme.fg("dim", `#${input.runId}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);

			if (context.isError) {
				const message = result.content[0];
				return new Text(theme.fg("error", `Error: ${message?.type === "text" ? message.text : "unknown error"}`), 0, 0);
			}

			const details = result.details as { result?: unknown } | undefined;
			const data = details?.result;
			if (data === undefined) {
				const message = result.content[0];
				return new Text(message?.type === "text" ? message.text : "", 0, 0);
			}

			const summary = summarize(data, theme);
			let text = summary;
			const url = findFirstUrl(data);
			if (url) text += `\n${openLine(url, theme)}`;
			if (expanded) text += `\n${theme.fg("dim", JSON.stringify(data, null, 2))}`;
			return new Text(text, 0, 0);
		},
	});
}

interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

const TAIL_PREVIEW_LINES = 5;

/** One compact, action-shaped summary line (or few) -- the human-facing counterpart to the JSON sent to the LLM. */
export function summarize(data: unknown, theme: ThemeLike): string {
	if (!data || typeof data !== "object") return String(data);
	const d = data as Record<string, unknown>;

	// ci.help
	if (Array.isArray(d.backends)) {
		const backends = d.backends as Array<{ name: string; capabilities: string }>;
		const pipelines = Array.isArray(d.pipelines) ? (d.pipelines as string[]) : [];
		const lines = backends.map((b) => `  ${theme.fg("accent", b.name)} ${theme.fg("dim", b.capabilities)}`);
		return [theme.fg("muted", `${backends.length} backend(s):`), ...lines, pipelines.length > 0 ? theme.fg("muted", `Pipelines: ${pipelines.join(", ")}`) : undefined]
			.filter((line): line is string => line !== undefined)
			.join("\n");
	}

	// ci.status / ci.trigger (pipeline form)
	if (d.pipelineRun && typeof d.pipelineRun === "object") {
		const run = d.pipelineRun as { pipeline: string; status: string; steps: Array<{ jobName: string; status: string }> };
		const steps = run.steps.map((s) => `  ${statusGlyph(s.status, theme)} ${theme.fg("muted", s.jobName)}`).join("\n");
		return `${statusGlyph(run.status, theme)} ${theme.fg("accent", run.pipeline)}\n${steps}`;
	}

	// ci.status (direct backend/jobRef form): CIVerdict
	if (d.verdict && typeof d.verdict === "object") {
		const verdict = d.verdict as { check: { backend: string; jobRef: string; runId: string; status: string }; failure?: { classification: string; failedJob?: string } };
		const { check } = verdict;
		let text = `${statusGlyph(check.status, theme)} ${theme.fg("accent", `${check.backend}/${check.jobRef}`)} ${theme.fg("dim", `#${check.runId}`)}`;
		if (verdict.failure) {
			text += `\n${theme.fg("error", verdict.failure.classification)}`;
			if (verdict.failure.failedJob) text += theme.fg("muted", ` (${verdict.failure.failedJob})`);
		}
		return text;
	}

	// ci.trigger (direct backend/jobRef form): TriggerResult
	if (d.result && typeof d.result === "object" && "jobRef" in (d.result as object)) {
		const trigger = d.result as { backend: string; jobRef: string; buildNumber?: string; queueId?: string };
		const id = trigger.buildNumber ?? trigger.queueId ?? "(pending)";
		return `${theme.fg("success", "Triggered")} ${theme.fg("accent", `${trigger.backend}/${trigger.jobRef}`)} ${theme.fg("dim", `#${id}`)}`;
	}

	// ci.wait: WatchStatus, optionally with a streamed tail preview attached
	if (typeof d.status === "string" && typeof d.buildNumber === "string" && "progressPercent" in d) {
		const watch = d as { buildNumber: string; status: string; progressPercent: number; overdue: boolean; tail?: { text: string; truncated: boolean } };
		let text = `${statusGlyph(watch.status, theme)} ${theme.fg("dim", `#${watch.buildNumber}`)} ${theme.fg("muted", `${Math.round(watch.progressPercent)}%`)}`;
		if (watch.overdue) text += ` ${theme.fg("warning", "overdue")}`;
		if (watch.tail?.text) {
			const lines = watch.tail.text.split("\n");
			const preview = lines.slice(-TAIL_PREVIEW_LINES).join("\n");
			text += `\n${theme.fg("dim", preview)}`;
			if (watch.tail.truncated || lines.length > TAIL_PREVIEW_LINES) text += `\n${theme.fg("dim", "...")}`;
		}
		return text;
	}

	// ci.wait (opaqueRef resolve form)
	if (typeof d.buildNumber === "string") return `${theme.fg("muted", "Resolved to")} ${theme.fg("dim", `#${d.buildNumber}`)}`;

	// ci.cancel
	if (d.status === "cancelled") return `${theme.fg("warning", "✗ Cancelled")} ${theme.fg("dim", `#${d.runId}`)}`;

	// ci.log / ci.tail: line/text-shaped result
	if (typeof d.totalLines === "number") {
		const log = d as { totalLines: number; truncated?: boolean; filtered?: boolean };
		return theme.fg("muted", `${log.totalLines} line(s)${log.truncated ? ", truncated" : ""}${log.filtered ? ", filtered" : ""}`);
	}
	if (typeof d.outputTokens === "number" && typeof d.runId === "string") {
		const tail = d as { runId: string; status: string; truncated: boolean; outputTokens: number };
		return `${statusGlyph(tail.status, theme)} ${theme.fg("dim", `#${tail.runId}`)} ${theme.fg("muted", `${tail.outputTokens} tok${tail.truncated ? ", truncated" : ""}`)}`;
	}

	// ci.search / ci.downstream: { builds } / { runs }
	for (const key of ["builds", "runs"]) {
		const list = d[key];
		if (Array.isArray(list)) return theme.fg("muted", `${list.length} run(s)`);
	}

	// ci.pool: { runs: RunSnapshot[] } already covered above via "runs"; ci.subscribe/unsubscribe
	if (d.subscribed === true) return theme.fg("success", "✓ Subscribed");
	if (d.unsubscribed === true) return theme.fg("success", "✓ Unsubscribed");

	// ci.stages
	if (Array.isArray(d.stages)) return theme.fg("muted", `${d.stages.length} stage(s)`);

	// ci.chain: CIRunNode (has its own status/name at the top level)
	if (typeof d.status === "string" && typeof d.name === "string") {
		const node = d as { name: string; status: string; children?: unknown[] };
		const childCount = node.children?.length ?? 0;
		return `${statusGlyph(node.status, theme)} ${theme.fg("accent", node.name)}${childCount > 0 ? theme.fg("dim", ` (${childCount} downstream)`) : ""}`;
	}

	return theme.fg("muted", "Done");
}

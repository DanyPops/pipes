/**
 * Human-facing TUI rendering for the ci tool, kept separate from ci-tool.ts's
 * LLM-facing execute()/schema. content (JSON) and this render path are two
 * genuinely different channels reading the same result: content is exact and
 * complete for the model, this is compact and scannable for a human, and
 * always surfaces a clickable URL when the underlying data has one.
 */
import { hyperlink } from "@earendil-works/pi-tui";

const MAX_URL_SEARCH_DEPTH = 6;
const MAX_URL_SEARCH_NODES = 500;

/**
 * Finds the first string field literally named "url" anywhere in the result,
 * breadth-first so a top-level url (the common case) always wins over one
 * buried in a nested array. Bounded so a large search/pool/chain result can't
 * make this walk unbounded work.
 */
export function findFirstUrl(value: unknown): string | undefined {
	const queue: unknown[] = [value];
	let visited = 0;
	let depth = 0;
	while (queue.length > 0 && depth <= MAX_URL_SEARCH_DEPTH && visited < MAX_URL_SEARCH_NODES) {
		const levelSize = queue.length;
		for (let i = 0; i < levelSize; i++) {
			const node = queue.shift();
			visited++;
			if (visited > MAX_URL_SEARCH_NODES) break;
			if (!node || typeof node !== "object") continue;
			const record = node as Record<string, unknown>;
			if (typeof record.url === "string" && record.url.length > 0) return record.url;
			for (const child of Object.values(record)) {
				if (child && typeof child === "object") queue.push(child);
			}
		}
		depth++;
	}
	return undefined;
}

const STATUS_ICON: Record<string, { glyph: string; color: string }> = {
	success: { glyph: "✓", color: "success" },
	failure: { glyph: "✗", color: "error" },
	running: { glyph: "●", color: "warning" },
	pending: { glyph: "○", color: "muted" },
	aborted: { glyph: "⊘", color: "muted" },
	not_found: { glyph: "?", color: "dim" },
};

export function statusGlyph(status: string | undefined, theme: { fg(color: string, text: string): string }): string {
	const known = status ? STATUS_ICON[status] : undefined;
	if (!known) return theme.fg("dim", status ?? "unknown");
	return theme.fg(known.color, `${known.glyph} ${status}`);
}

/** Wraps a URL as a clickable OSC 8 hyperlink (plain text on terminals without support) with a leading label. */
export function openLine(url: string, theme: { fg(color: string, text: string): string }): string {
	return theme.fg("dim", "Open: ") + theme.fg("accent", hyperlink(url, url));
}

interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/**
 * The text a projected ci_* tool call result renders as, before any URL/expanded-JSON
 * lines get appended -- split out from a renderResult so the isPartial/error/no-data-yet
 * branching is unit-testable without a full registerTool harness. A still-in-flight
 * ci_wait reports a real WatchStatus+tail snapshot on every ~20s server-side poll tick via
 * onUpdate; this renders that snapshot through the same summarize() path as a final result
 * instead of discarding it for a bare "Running..." the whole time. Only falls back to that
 * placeholder before the first tick has landed any data at all.
 */
export function renderResultText(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	isPartial: boolean,
	isError: boolean,
	theme: ThemeLike,
	/** Overrides ci.wait's own WatchStatus.progressPercent for display -- lets a caller (vehicle-client.ts's
	 * tickCiWaitProgress) thread in a client-side-eased value instead of whatever the server most recently
	 * reported, so the "xx%" text climbs in step with the animated bar instead of snapping ahead of it. */
	displayPercentOverride?: number,
): string {
	// vehicle-client-pi's own PiVehicleToolDetails declares output and progress as two distinct
	// fields on purpose: invokeVehicleOperation's reportProgress() (see vehicle-pi.ts) builds every
	// in-flight onUpdate tick as { vehicle, progress } -- output is only ever set on the final
	// settled result. Reading only .output here left every partial tick with data === undefined,
	// so a still-running ci_wait rendered a bare "Running..." for its entire lifetime, never the
	// WatchStatus+tail snapshot this function's own doc comment above already promises.
	const details = result.details as { output?: unknown; progress?: unknown } | undefined;
	const data = details?.output ?? details?.progress;

	if (isPartial && data === undefined) return theme.fg("warning", "Running...");

	if (!isPartial && isError) {
		const message = result.content[0];
		return theme.fg("error", `Error: ${message?.type === "text" ? message.text : "unknown error"}`);
	}

	if (data === undefined) {
		const message = result.content[0];
		return message?.type === "text" ? (message.text ?? "") : "";
	}

	const summary = summarize(data, theme, displayPercentOverride);
	return isPartial ? `${theme.fg("warning", "Running...")} ${summary}` : summary;
}

/** Clamps a reported progress percentage into the displayable 0..100 range -- a run that overruns
 * its estimated duration (see orchestrator.ts's elapsed/estimated projection) can report over 100%,
 * which is meaningful server-side (it's how "overdue" gets set) but nonsensical rendered next to a
 * bar that's necessarily already full. */
export function clampDisplayPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

/** Mirrors packages/pipes' own RunStatus's isTerminalStatus (a settled run's terminal states) --
 * duplicated here rather than imported since ci-render.ts is pure presentation with no dependency
 * on the daemon package, and this specific set (the WatchStatus.status strings a run can settle
 * into) is a small, stable contract already mirrored locally by STATUS_ICON above. */
export function isTerminalWatchStatus(status: string): boolean {
	return status === "success" || status === "failure" || status === "aborted" || status === "not_found";
}

/**
 * orchestrator.ts's own WatchStatus.progressPercent is deliberately actual-vs-estimated-duration
 * ("this run took 50% of the usual time" / "took 150%, flag it overdue"), not "percent of the
 * workflow completed" -- genuinely useful for a still-running watch, and for flagging a terminal
 * run that ran anomalously long even though it finished fine. But rendered as a bare "92%" next to
 * a ✓ success glyph, that ratio reads as "still not done" to a human, when the run is in fact
 * completely done. Once a run has reached a terminal status there is nothing left to be a
 * percentage *of* -- always show 100% (a full bar) there; the overdue flag alongside it still
 * carries the "took longer than usual" signal on its own. */
export function effectiveWatchPercent(status: string, rawPercent: number): number {
	return isTerminalWatchStatus(status) ? 100 : clampDisplayPercent(rawPercent);
}

const TAIL_PREVIEW_LINES = 5;

/** One compact, action-shaped summary line (or few) -- the human-facing counterpart to the JSON sent to the LLM. */
export function summarize(data: unknown, theme: ThemeLike, displayPercentOverride?: number): string {
	if (!data || typeof data !== "object") return String(data);
	const d = data as Record<string, unknown>;

	// ci.help
	if (Array.isArray(d.backends)) {
		const backends = d.backends as Array<{ name: string; capabilities: string }>;
		const pipelines = Array.isArray(d.pipelines) ? (d.pipelines as string[]) : [];
		const lines = backends.map((b) => `  ${theme.fg("accent", b.name)} ${theme.fg("dim", b.capabilities)}`);
		return [
			theme.fg("muted", `${backends.length} backend(s):`),
			...lines,
			pipelines.length > 0 ? theme.fg("muted", `Pipelines: ${pipelines.join(", ")}`) : undefined,
		]
			.filter((line): line is string => line !== undefined)
			.join("\n");
	}

	// ci.presets.list: full bookmark definitions, not just names (unlike ci.help's bare pipelines[])
	if (Array.isArray(d.presets)) {
		const presets = d.presets as Array<{ name: string; backend: string; steps: Array<{ jobName: string }> }>;
		if (presets.length === 0) return theme.fg("muted", "No bookmarked presets yet.");
		const lines = presets.map(
			(p) => `  ${theme.fg("accent", p.name)} ${theme.fg("dim", `(${p.backend}: ${p.steps.map((s) => s.jobName).join(", ")})`)}`,
		);
		return [theme.fg("muted", `${presets.length} preset(s):`), ...lines].join("\n");
	}

	// ci.presets.set: the saved/overwritten preset echoed back
	if (d.preset && typeof d.preset === "object" && "steps" in (d.preset as object)) {
		const preset = d.preset as { name: string; backend: string; steps: Array<{ jobName: string }> };
		return `${theme.fg("success", "\u2713 Bookmarked")} ${theme.fg("accent", preset.name)} ${theme.fg("dim", `(${preset.backend}: ${preset.steps.map((s) => s.jobName).join(", ")})`)}`;
	}

	// ci.presets.remove
	if (typeof d.removed === "boolean") {
		return d.removed ? theme.fg("success", "\u2713 Removed") : theme.fg("muted", "No such preset -- nothing removed");
	}

	// ci.status / ci.trigger (pipeline form)
	if (d.pipelineRun && typeof d.pipelineRun === "object") {
		const run = d.pipelineRun as { pipeline: string; status: string; steps: Array<{ jobName: string; status: string }> };
		const steps = run.steps.map((s) => `  ${statusGlyph(s.status, theme)} ${theme.fg("muted", s.jobName)}`).join("\n");
		return `${statusGlyph(run.status, theme)} ${theme.fg("accent", run.pipeline)}\n${steps}`;
	}

	// ci.status (direct backend/jobRef form): CIVerdict
	if (d.verdict && typeof d.verdict === "object") {
		const verdict = d.verdict as {
			check: { backend: string; jobRef: string; runId: string; status: string };
			failure?: { classification: string; failedJob?: string };
		};
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
		const watch = d as {
			buildNumber: string;
			status: string;
			progressPercent: number;
			overdue: boolean;
			tail?: { text: string; truncated: boolean };
		};
		const shownPercent = displayPercentOverride ?? effectiveWatchPercent(watch.status, watch.progressPercent);
		let text = `${statusGlyph(watch.status, theme)} ${theme.fg("dim", `#${watch.buildNumber}`)} ${theme.fg("muted", `${Math.round(shownPercent)}%`)}`;
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

	// ci.discover: { repos } / { workflows }
	if (Array.isArray(d.repos)) {
		const repos = d.repos as Array<{ name: string; private: boolean }>;
		if (repos.length === 0) return theme.fg("muted", "No repos found.");
		const lines = repos.map((r) => `  ${theme.fg("accent", r.name)}${r.private ? theme.fg("dim", " (private)") : ""}`);
		return [theme.fg("muted", `${repos.length} repo(s):`), ...lines].join("\n");
	}
	if (Array.isArray(d.workflows)) {
		const workflows = d.workflows as Array<{ name: string; fileName: string; state: string }>;
		if (workflows.length === 0) return theme.fg("muted", "No workflows found.");
		const lines = workflows.map((w) => `  ${theme.fg("accent", w.fileName)} ${theme.fg("dim", `(${w.name}, ${w.state})`)}`);
		return [theme.fg("muted", `${workflows.length} workflow(s):`), ...lines].join("\n");
	}

	// ci.search / ci.downstream: { builds } / { runs }. ci.search alone can carry `truncated: true`
	// (see run/ci-run.ts's SearchResult) -- the search gave up at a page-cap safety valve before
	// `since`/`limit` was conclusively satisfied, so "N run(s)" alone would read as a complete result
	// when it might not be.
	for (const key of ["builds", "runs"]) {
		const list = d[key];
		if (!Array.isArray(list)) continue;
		const count = theme.fg("muted", `${list.length} run(s)`);
		return key === "builds" && d.truncated === true
			? `${count} ${theme.fg("warning", "(search stopped early -- since/limit may not be fully covered)")}`
			: count;
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

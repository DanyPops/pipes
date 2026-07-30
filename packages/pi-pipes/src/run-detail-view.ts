/**
 * Full-screen scrollable detail view for one CI run -- the richer alternative
 * to pipes-tui.ts's showScreen (a compact, one-key-dismiss block). Mirrors
 * pi-tickets' IssueDetailComponent/pi-papyrus's ArtifactDetailViewport shape:
 * border/footer/scroll-offset chrome hand-rolled here, field+section line
 * building delegated to malevich's buildDetailLines.
 *
 * Walking skeleton: a single run's status + log excerpt. Full stages/artifact
 * trees are a real future step, not this one.
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { buildDetailLines, type DetailField, type DetailSection, type TextMeasure } from "malevich-tui-components";

const RESERVED_ROWS = 4;
const MIN_VISIBLE_LINES = 3;
const measure: TextMeasure = { visibleWidth, truncateToWidth, wrapTextWithAnsi };

export interface RunDetailCheck {
	backend: string;
	jobRef: string;
	runId: string;
	status: string;
	checkedAt?: string;
	url?: string;
}

export interface RunDetailFailure {
	classification: string;
	failedJob?: string;
	canRetry?: boolean;
}

export interface RunDetailLog {
	lines: string[];
	totalLines: number;
	truncated?: boolean;
}

export interface RunDetailData {
	check: RunDetailCheck;
	failure?: RunDetailFailure;
	log?: RunDetailLog;
}

/** Plain-text rendering for non-TUI callers (RPC, piped/non-terminal). */
export function runDetailText(data: RunDetailData): string {
	const { check, failure, log } = data;
	let output = `${check.backend}/${check.jobRef} #${check.runId} -- ${check.status}`;
	if (check.checkedAt) output += `\nChecked: ${check.checkedAt}`;
	if (check.url) output += `\nURL: ${check.url}`;
	if (failure) {
		output += `\n\nFailure: ${failure.classification}`;
		if (failure.failedJob) output += ` (${failure.failedJob})`;
	}
	if (log && log.lines.length > 0) {
		output += `\n\nLog (${log.totalLines} line(s)${log.truncated ? ", truncated" : ""}):\n${log.lines.join("\n")}`;
	}
	return output;
}

class RunDetailViewport implements Component {
	private offsetY = 0;
	private lines: string[] = [];
	private renderedWidth = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly data: RunDetailData,
		private readonly close: () => void,
	) {}

	invalidate(): void { this.renderedWidth = 0; }

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - 2);
		this.buildLines(contentWidth);
		const visible = computeVisibleLines(this.tui);
		this.offsetY = Math.min(this.offsetY, Math.max(0, this.lines.length - visible));
		const end = Math.min(this.lines.length, this.offsetY + visible);
		const theme = this.theme;
		const border = theme.fg("accent", "\u2500".repeat(Math.max(1, width)));
		const { check } = this.data;
		const title = `${check.backend}/${check.jobRef} #${check.runId}`;
		const footer = [
			this.lines.length > visible ? `\u2191/\u2193 scroll \u00b7 pgup/pgdn page \u00b7 ${this.offsetY + 1}-${end}/${this.lines.length}` : "\u2191/\u2193 scroll \u00b7 pgup/pgdn page",
			"esc close",
		].join(" \u00b7 ");
		return [
			border,
			truncateToWidth(theme.fg("accent", theme.bold(title)), width, ""),
			border,
			...this.lines.slice(this.offsetY, end).map((line) => truncateToWidth(` ${line}`, width, "")),
			truncateToWidth(theme.fg("dim", footer), width, ""),
			border,
		];
	}

	handleInput(data: string): void {
		const visible = computeVisibleLines(this.tui);
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.close(); return; }
		if (matchesKey(data, "up")) this.offsetY = Math.max(0, this.offsetY - 1);
		else if (matchesKey(data, "down")) this.offsetY = Math.min(Math.max(0, this.lines.length - visible), this.offsetY + 1);
		else if (matchesKey(data, "pageUp")) this.offsetY = Math.max(0, this.offsetY - visible);
		else if (matchesKey(data, "pageDown")) this.offsetY = Math.min(Math.max(0, this.lines.length - visible), this.offsetY + visible);
		else return;
		this.tui.requestRender();
	}

	private buildLines(width: number): void {
		if (this.renderedWidth === width) return;
		this.renderedWidth = width;
		const theme = this.theme;
		const { check, failure, log } = this.data;

		const fields: DetailField[] = [
			{ label: "Status", value: check.status },
			...(check.checkedAt ? [{ label: "Checked", value: check.checkedAt }] : []),
			...(check.url ? [{ label: "URL", value: check.url }] : []),
		];

		const sections: DetailSection[] = [];
		if (failure) {
			sections.push({
				heading: "Failure:",
				lines: [`  ${failure.classification}`, ...(failure.failedJob ? [`  job: ${failure.failedJob}`] : [])],
			});
		}
		if (log && log.lines.length > 0) {
			sections.push({ heading: `Log (${log.totalLines} line(s)${log.truncated ? ", truncated" : ""}):`, body: log.lines.join("\n") });
		}

		this.lines = buildDetailLines(width, {
			fields,
			sections,
			measure,
			theme: {
				field: (s) => theme.fg("muted", s),
				heading: (s) => theme.fg("muted", s),
				byline: (s) => theme.fg("dim", s),
				body: (s) => theme.fg("text", s),
				line: (s) => theme.fg("dim", s),
			},
		});
		this.offsetY = Math.min(this.offsetY, Math.max(0, this.lines.length - computeVisibleLines(this.tui)));
	}
}

function computeVisibleLines(tui: TUI): number {
	return Math.max(MIN_VISIBLE_LINES, tui.terminal.rows - RESERVED_ROWS);
}

export async function showRunDetailView(ctx: ExtensionCommandContext, data: RunDetailData): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(runDetailText(data), "info");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new RunDetailViewport(tui, theme, data, done));
}

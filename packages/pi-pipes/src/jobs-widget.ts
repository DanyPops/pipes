/**
 * Pure projection/render pair for the subscribed-jobs widget -- mirrors pi-papyrus's own
 * task-widget.ts (buildTaskWidgetProjection) / index.ts (renderTaskWidgetLines) split: graph/runs
 * in, a bounded intermediate shape out, no I/O, no TUI, fully unit-testable without a real daemon
 * or terminal. See jobs-overlay.ts for the stateful ctx.ui.setWidget-registered class that drives
 * these from a live ci.subscribed poll.
 */

import { VEHICLE_NAME } from "@danypops/pipes";
import { vehicleWidgetTitle } from "@danypops/vehicle-client-pi/widget-header";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { ProgressBar, type ProgressBarGlyphStyle, type ProgressBarGlyphs } from "malevich-tui-components";
import { effectiveWatchPercent, statusGlyph } from "./ci-render.ts";

/** One subscribed job's last-known status -- the widget's own minimal shape, not packages/pipes'
 * RunSnapshot directly: pi-pipes talks to the daemon over RPC/JSON, never imports the daemon's own
 * domain types, the same boundary every other pi-pipes rendering path (ci-render.ts) already keeps. */
export interface JobsWidgetRow {
	backend: string;
	jobRef: string;
	runId: string;
	status: string;
	url?: string;
	/** Undefined (not 0) when the backend has no real estimate to compute from -- e.g. GitLab's own
	 * estimateDuration() always returning 0 server-side (see orchestrator.ts's ciGetRunWithProgress).
	 * A row with no progressPercent renders status-only, no bar. */
	progressPercent?: number;
	overdue?: boolean;
	/** The project this subscription was attributed to (see @danypops/pipes' ci.subscribe/
	 * ci.subscribed and @danypops/vehicle-server/project-scope) -- undefined for a subscription
	 * with no known project (e.g. a raw RPC client with no Pi session behind it at all). */
	projectName?: string;
}

export interface JobsWidgetProjection {
	rows: JobsWidgetRow[];
	total: number;
}

function rowKey(row: JobsWidgetRow): string {
	return `${row.backend}/${row.jobRef}/${row.runId}`;
}

/** ci.subscribed's own underlying SELECT carries no ORDER BY -- sorting here, not trusting whatever
 * order the pool happened to return rows in, is what keeps the widget's row order stable across polls
 * instead of visibly reshuffling every tick. */
export function buildJobsWidgetProjection(runs: readonly JobsWidgetRow[]): JobsWidgetProjection {
	const rows = [...runs].sort((a, b) => (rowKey(a) < rowKey(b) ? -1 : rowKey(a) > rowKey(b) ? 1 : 0));
	return { rows, total: rows.length };
}

const JOBS_WIDGET_BAR_WIDTH = 10;

/** Renders the widget's lines for a given projection -- `[]` (hide the whole widget) when nothing is
 * subscribed, matching pi-papyrus's own `openTotal === 0` convention rather than an empty box. */
export function renderJobsWidgetLines(
	theme: { fg(color: string, text: string): string },
	projection: JobsWidgetProjection,
	width: number,
	progressBarGlyphs: ProgressBarGlyphs | ProgressBarGlyphStyle = "blocks",
): string[] {
	if (projection.total === 0) return [];

	const header = truncateToWidth(theme.fg("muted", vehicleWidgetTitle(VEHICLE_NAME, "Jobs", `${projection.total} subscribed`)), width, "…");
	const lines: string[] = [header];
	for (const row of projection.rows) {
		let line = `${statusGlyph(row.status, theme)} ${theme.fg("accent", `${row.backend}/${row.jobRef}`)} ${theme.fg("dim", `#${row.runId}`)}`;
		if (row.projectName) line += ` ${theme.fg("dim", `(${row.projectName})`)}`;
		if (row.progressPercent !== undefined) {
			const shown = effectiveWatchPercent(row.status, row.progressPercent);
			const bar = new ProgressBar({ value: shown, max: 100, width: JOBS_WIDGET_BAR_WIDTH, glyphs: progressBarGlyphs }).format();
			line += ` ${theme.fg("accent", bar)} ${theme.fg("muted", `${Math.round(shown)}%`)}`;
			if (row.overdue) line += ` ${theme.fg("warning", "overdue")}`;
		}
		lines.push(truncateToWidth(line, width, "…"));
	}
	return lines;
}

/**
 * Pure projection/render pair for the subscribed-jobs widget -- mirrors pi-papyrus's own
 * task-widget.ts (buildTaskWidgetProjection) / index.ts (renderTaskWidgetLines) split: graph/runs
 * in, a bounded intermediate shape out, no I/O, no TUI, fully unit-testable without a real daemon
 * or terminal. See jobs-overlay.ts for the stateful ctx.ui.setWidget-registered class that drives
 * these from a live ci.subscribed poll.
 */

import { VEHICLE_NAME } from "@danypops/pipes";
import { vehicleWidgetTitle } from "@danypops/vehicle-client-pi/widget-header";
import { hyperlink, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	type AutoRotatingWindow,
	ProgressBar,
	type ProgressBarGlyphStyle,
	type ProgressBarGlyphs,
	renderCardRow,
	Table,
	type TableColumn,
	type TextMeasure,
} from "malevich-tui-components";
import { effectiveWatchPercent, statusGlyph } from "./ci-render.ts";

const measure: TextMeasure = { visibleWidth, truncateToWidth, wrapTextWithAnsi };

/** Visible job rows per page before the auto-rotating overflow hint pages to the next. */
export const PIPES_JOBS_WIDGET_VISIBLE_ROWS = 5;

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
	/** RunSnapshot's own real start time -- the still-running fallback runtimeMs() computes elapsed
	 * from when durationMs isn't settled yet. */
	startedAt?: Date;
	/** RunSnapshot's own settled runtime once the daemon has one -- always preferred over computing
	 * elapsed from startedAt, since a terminal run's runtime must stop advancing once it's actually done. */
	durationMs?: number;
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

/** A terminal row's own settled durationMs always wins over a live elapsed computation -- a
 * finished run's runtime must not keep advancing just because the widget is still on screen.
 * A still-running row with no durationMs yet computes elapsed from startedAt against `now`,
 * letting the column tick up in step with the rotation ticker's own repaint-only refresh. */
function runtimeMs(row: JobsWidgetRow, now: number): number | undefined {
	if (row.durationMs !== undefined) return row.durationMs;
	if (row.startedAt !== undefined) return Math.max(0, now - row.startedAt.getTime());
	return undefined;
}

function formatRuntime(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

/** Columns are data-driven: "Progress"/"Project"/"Runtime" only appear at all once at least one
 * visible row actually has that field, matching the widget's own prior behavior of omitting an
 * absent optional field entirely rather than rendering an always-empty column. */
function jobsTableColumns(rows: readonly JobsWidgetRow[], now: number): TableColumn[] {
	const columns: TableColumn[] = [
		{ header: "", key: "status" },
		{ header: "Job", key: "job" },
		{ header: "Run", key: "run" },
	];
	if (rows.some((row) => row.progressPercent !== undefined)) columns.push({ header: "Progress", key: "progress" });
	if (rows.some((row) => runtimeMs(row, now) !== undefined)) columns.push({ header: "Runtime", key: "runtime" });
	if (rows.some((row) => row.projectName)) columns.push({ header: "Project", key: "project" });
	if (rows.some((row) => row.url)) columns.push({ header: "URL", key: "url" });
	return columns;
}

function jobsTableRow(
	theme: { fg(color: string, text: string): string },
	row: JobsWidgetRow,
	progressBarGlyphs: ProgressBarGlyphs | ProgressBarGlyphStyle,
	now: number,
): Record<string, string> {
	const cells: Record<string, string> = {
		status: statusGlyph(row.status, theme),
		job: theme.fg("accent", `${row.backend}/${row.jobRef}`),
		run: theme.fg("dim", `#${row.runId}`),
	};
	if (row.progressPercent !== undefined) {
		const shown = effectiveWatchPercent(row.status, row.progressPercent);
		const bar = new ProgressBar({ value: shown, max: 100, width: JOBS_WIDGET_BAR_WIDTH, glyphs: progressBarGlyphs }).format();
		let progress = `${theme.fg("accent", bar)} ${theme.fg("muted", `${Math.round(shown)}%`)}`;
		if (row.overdue) progress += ` ${theme.fg("warning", "overdue")}`;
		cells.progress = progress;
	}
	const runtime = runtimeMs(row, now);
	if (runtime !== undefined) cells.runtime = theme.fg("dim", formatRuntime(runtime));
	if (row.projectName) cells.project = theme.fg("dim", `(${row.projectName})`);
	if (row.url) cells.url = theme.fg("accent", hyperlink(row.url, row.url));
	return cells;
}

/** "Pipes · Jobs · <N> subscribed", plus a "page/total ⟳" suffix once genuinely paging. */
function jobsCardLabel(projection: JobsWidgetProjection, rotation?: AutoRotatingWindow): string {
	const base = vehicleWidgetTitle(VEHICLE_NAME, "Jobs", `${projection.total} subscribed`);
	return rotation?.isPaging ? `${base} · ${rotation.pageIndex + 1}/${rotation.pageCount} ⟳` : base;
}

/** Renders the widget as a single bordered card -- `[]` (hide the whole widget) when nothing is
 * subscribed, matching pi-papyrus's own `openTotal === 0` convention rather than an empty box.
 * `rotation`, when given, bounds the visible rows to its own current page and is kept in sync with
 * the real row count here (the caller only needs to own the instance, not maintain it). */
export function renderJobsWidgetLines(
	theme: { fg(color: string, text: string): string },
	projection: JobsWidgetProjection,
	width: number,
	progressBarGlyphs: ProgressBarGlyphs | ProgressBarGlyphStyle = "blocks",
	rotation?: AutoRotatingWindow,
	/** Injectable for tests; a still-running row's Runtime column computes elapsed against this
	 * rather than calling Date.now() itself. */
	now: number = Date.now(),
): string[] {
	if (projection.total === 0) return [];
	rotation?.setTotalRows(projection.rows.length);
	const { start, end } = rotation?.currentPageBounds() ?? { start: 0, end: projection.rows.length };
	const visibleRows = projection.rows.slice(start, end);

	return renderCardRow(
		[
			{
				label: jobsCardLabel(projection, rotation),
				render: (innerWidth: number) =>
					new Table({
						columns: jobsTableColumns(visibleRows, now),
						rows: visibleRows.map((row) => jobsTableRow(theme, row, progressBarGlyphs, now)),
						measure,
						headerStyle: (text) => theme.fg("dim", text),
					}).render(innerWidth),
			},
		],
		width,
		{ measure, frameStyle: (s) => theme.fg("borderMuted", s) },
	);
}

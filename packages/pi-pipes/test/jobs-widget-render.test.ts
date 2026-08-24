import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AutoRotatingWindow } from "malevich-tui-components";
import { buildJobsWidgetProjection, type JobsWidgetRow, renderJobsWidgetLines } from "../src/jobs-widget.ts";

const theme = {
	fg: (_color: string, text: string) => text,
} as Theme;

function row(overrides: Partial<JobsWidgetRow> = {}): JobsWidgetRow {
	return { backend: "gh", jobRef: "job", runId: "1", status: "running", ...overrides };
}

function rotation(pageSize: number, totalRows: number, now: () => number = () => 0): AutoRotatingWindow {
	return new AutoRotatingWindow({ totalRows, pageSize, intervalMs: 1000, now });
}

describe("renderJobsWidgetLines", () => {
	it("returns no lines at all (hides the widget) when nothing is subscribed", () => {
		const lines = renderJobsWidgetLines(theme, buildJobsWidgetProjection([]), 80);
		expect(lines).toEqual([]);
	});

	it("renders a bordered card whose own top-border title names the owning Vehicle, the widget, and the subscribed count, plus a header/separator and one line per row", () => {
		const projection = buildJobsWidgetProjection([row({ runId: "1" }), row({ jobRef: "other", runId: "2" })]);
		const lines = renderJobsWidgetLines(theme, projection, 80);
		expect(lines[0]).toContain("Pipes · Jobs · 2 subscribed");
		expect(lines[0]).toContain("╭");
		expect(lines[lines.length - 1]).toContain("╰");
		expect(lines).toHaveLength(6); // top border, table header, table separator, 2 rows, bottom border
	});

	it("aligns every row's Job/Run columns as a real table -- same column start position across rows", () => {
		const projection = buildJobsWidgetProjection([
			row({ backend: "gh", jobRef: "a", runId: "1" }),
			row({ backend: "jenkins-auto", jobRef: "deploy", runId: "40531" }),
		]);
		const lines = renderJobsWidgetLines(theme, projection, 80);
		expect(lines[1]).toMatch(/Job\s+Run/); // header row
		const jobColumnStart = lines[1]?.indexOf("Job");
		expect(lines[3]?.indexOf("gh/a")).toBe(jobColumnStart);
		expect(lines[4]?.indexOf("jenkins-auto/deploy")).toBe(jobColumnStart);
	});

	it("shows a run's backend/jobRef and run id on its own line", () => {
		const projection = buildJobsWidgetProjection([row({ backend: "jenkins-auto", jobRef: "deploy", runId: "40531" })]);
		const lines = renderJobsWidgetLines(theme, projection, 80);
		expect(lines[3]).toContain("jenkins-auto/deploy");
		expect(lines[3]).toContain("#40531");
	});

	it("shows a bar and percent for a row with real progress data", () => {
		const projection = buildJobsWidgetProjection([row({ progressPercent: 42 })]);
		const lines = renderJobsWidgetLines(theme, projection, 80);
		expect(lines[1]).toContain("Progress"); // header names the column
		expect(lines[3]).toContain("42%");
		expect(lines[3]).toContain("■"); // default "blocks" glyph style's filled cell
	});

	it("shows no Progress column at all for a row with no progress data -- e.g. a GitLab run (estimateDuration always 0)", () => {
		const projection = buildJobsWidgetProjection([row({ status: "running" })]); // progressPercent omitted entirely
		const lines = renderJobsWidgetLines(theme, projection, 80);
		expect(lines[1]).not.toContain("Progress");
		expect(lines[3]).not.toContain("%");
		expect(lines[3]).not.toContain("■");
	});

	it("forces a terminal row to show 100%, not its raw actual-vs-estimated ratio, matching ci_wait's own display rule", () => {
		const projection = buildJobsWidgetProjection([row({ status: "success", progressPercent: 92 })]);
		const lines = renderJobsWidgetLines(theme, projection, 80);
		expect(lines[3]).toContain("100%");
		expect(lines[3]).not.toContain("92%");
	});

	it("flags an overdue row, even though its shown percent for a still-running row is its own raw (non-terminal) value", () => {
		const projection = buildJobsWidgetProjection([row({ status: "running", progressPercent: 160, overdue: true })]);
		const lines = renderJobsWidgetLines(theme, projection, 80);
		expect(lines[3]?.toLowerCase()).toContain("overdue");
		expect(lines[3]).toContain("100%"); // clamped, same as ci_wait's own overrun handling
	});

	it("shows a row's project name inline, in parentheses, when it has one", () => {
		const projection = buildJobsWidgetProjection([row({ projectName: "pipes" })]);
		const lines = renderJobsWidgetLines(theme, projection, 80);
		expect(lines[1]).toContain("Project"); // header names the column
		expect(lines[3]).toContain("(pipes)");
	});

	it("shows no Project column at all for a row with no project name -- e.g. a raw RPC client's subscription", () => {
		const projection = buildJobsWidgetProjection([row()]); // projectName omitted
		const lines = renderJobsWidgetLines(theme, projection, 80);
		expect(lines[1]).not.toContain("Project");
		expect(lines[3]).not.toContain("(");
	});

	it("shows a row's URL when it has one", () => {
		const projection = buildJobsWidgetProjection([row({ url: "https://example.test/runs/1" })]);
		const lines = renderJobsWidgetLines(theme, projection, 80);
		expect(lines[1]).toContain("URL"); // header names the column
		expect(lines[3]).toContain("https://example.test/runs/1");
	});

	it("shows no URL column at all for a row with no url -- e.g. a backend that never reported one", () => {
		const projection = buildJobsWidgetProjection([row()]); // url omitted
		const lines = renderJobsWidgetLines(theme, projection, 80);
		expect(lines[1]).not.toContain("URL");
	});

	it("shows a still-running row's Runtime as elapsed time since startedAt, against the given now", () => {
		const projection = buildJobsWidgetProjection([row({ startedAt: new Date(0) })]);
		const lines = renderJobsWidgetLines(theme, projection, 80, "blocks", undefined, 90_000); // 90s elapsed
		expect(lines[1]).toContain("Runtime"); // header names the column
		expect(lines[3]).toContain("1m30s");
	});

	it("ticks a still-running row's Runtime forward as now advances, unprompted by any change to the row itself", () => {
		const projection = buildJobsWidgetProjection([row({ startedAt: new Date(0) })]);
		const atTenSeconds = renderJobsWidgetLines(theme, projection, 80, "blocks", undefined, 10_000);
		const atOneMinute = renderJobsWidgetLines(theme, projection, 80, "blocks", undefined, 60_000);
		expect(atTenSeconds[3]).toContain("10s");
		expect(atOneMinute[3]).toContain("1m00s");
	});

	it("shows a terminal row's exact durationMs, not elapsed-since-startedAt, so it stops advancing once the run is done", () => {
		const projection = buildJobsWidgetProjection([row({ status: "success", startedAt: new Date(0), durationMs: 45_000 })]);
		// now is far past startedAt -- if this were computing elapsed instead of using durationMs, it would show a much larger value.
		const lines = renderJobsWidgetLines(theme, projection, 80, "blocks", undefined, 10 * 60 * 1000);
		expect(lines[3]).toContain("45s");
	});

	it("shows no Runtime column at all for a row with neither startedAt nor durationMs", () => {
		const projection = buildJobsWidgetProjection([row()]); // startedAt/durationMs both omitted
		const lines = renderJobsWidgetLines(theme, projection, 80);
		expect(lines[1]).not.toContain("Runtime");
	});

	it("keeps every line within the given width even once a long URL column is present", () => {
		const projection = buildJobsWidgetProjection([
			row({
				backend: "jenkins-auto",
				jobRef: "deploy",
				runId: "40531",
				url: "https://jenkins.example.test/job/deploy/40531/console-output-detail",
			}),
		]);
		for (const width of [40, 80, 120]) {
			const lines = renderJobsWidgetLines(theme, projection, width);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("never produces a line wider than the given width, across several widths", () => {
		const projection = buildJobsWidgetProjection([
			row({ backend: "jenkins-auto", jobRef: "ocp-baremetal-ipi-deployment-with-a-very-long-name", runId: "40531", progressPercent: 55 }),
		]);
		for (const width of [40, 80, 120]) {
			const lines = renderJobsWidgetLines(theme, projection, width);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	describe("auto-rotating overflow hint", () => {
		it("never shows a page hint when every subscribed job already fits on one page", () => {
			const projection = buildJobsWidgetProjection([row({ runId: "1" }), row({ runId: "2" })]);
			const lines = renderJobsWidgetLines(theme, projection, 80, "blocks", rotation(5, 2));
			expect(lines[0]).not.toMatch(/\d\/\d ⟳/);
		});

		it("shows a page/total rotation hint once subscribed jobs genuinely outgrow one page, and pages through them as the clock advances", () => {
			const rows = Array.from({ length: 5 }, (_, i) => row({ runId: String(i) }));
			const projection = buildJobsWidgetProjection(rows);
			let now = 0;
			const paging = rotation(2, 5, () => now);

			const page1 = renderJobsWidgetLines(theme, projection, 80, "blocks", paging);
			expect(page1[0]).toMatch(/1\/3 ⟳/);
			expect(page1).toHaveLength(6); // top border, table header, table separator, 2 rows, bottom border

			now = 1000;
			const page2 = renderJobsWidgetLines(theme, projection, 80, "blocks", paging);
			expect(page2[0]).toMatch(/2\/3 ⟳/);
		});
	});
});

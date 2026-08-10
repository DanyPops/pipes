import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildJobsWidgetProjection, type JobsWidgetRow, renderJobsWidgetLines } from "../src/jobs-widget.ts";

const theme = {
	fg: (_color: string, text: string) => text,
} as Theme;

function row(overrides: Partial<JobsWidgetRow> = {}): JobsWidgetRow {
	return { backend: "gh", jobRef: "job", runId: "1", status: "running", ...overrides };
}

describe("renderJobsWidgetLines", () => {
	it("returns no lines at all (hides the widget) when nothing is subscribed", () => {
		const lines = renderJobsWidgetLines(theme, buildJobsWidgetProjection([]), 80);
		expect(lines).toEqual([]);
	});

	it("renders a header naming the subscribed count, plus one line per row", () => {
		const projection = buildJobsWidgetProjection([row({ runId: "1" }), row({ jobRef: "other", runId: "2" })]);
		const lines = renderJobsWidgetLines(theme, projection, 80);
		expect(lines[0]).toContain("Jobs");
		expect(lines[0]).toContain("2");
		expect(lines).toHaveLength(3);
	});

	it("shows a run's backend/jobRef and run id on its own line", () => {
		const projection = buildJobsWidgetProjection([row({ backend: "jenkins-auto", jobRef: "deploy", runId: "40531" })]);
		const lines = renderJobsWidgetLines(theme, projection, 80);
		expect(lines[1]).toContain("jenkins-auto/deploy");
		expect(lines[1]).toContain("#40531");
	});

	it("shows a bar and percent for a row with real progress data", () => {
		const projection = buildJobsWidgetProjection([row({ progressPercent: 42 })]);
		const lines = renderJobsWidgetLines(theme, projection, 80);
		expect(lines[1]).toContain("42%");
		expect(lines[1]).toContain("■"); // default "blocks" glyph style's filled cell
	});

	it("shows no bar/percent at all for a row with no progress data -- e.g. a GitLab run (estimateDuration always 0)", () => {
		const projection = buildJobsWidgetProjection([row({ status: "running" })]); // progressPercent omitted entirely
		const lines = renderJobsWidgetLines(theme, projection, 80);
		expect(lines[1]).not.toContain("%");
		expect(lines[1]).not.toContain("■");
	});

	it("forces a terminal row to show 100%, not its raw actual-vs-estimated ratio, matching ci_wait's own display rule", () => {
		const projection = buildJobsWidgetProjection([row({ status: "success", progressPercent: 92 })]);
		const lines = renderJobsWidgetLines(theme, projection, 80);
		expect(lines[1]).toContain("100%");
		expect(lines[1]).not.toContain("92%");
	});

	it("flags an overdue row, even though its shown percent for a still-running row is its own raw (non-terminal) value", () => {
		const projection = buildJobsWidgetProjection([row({ status: "running", progressPercent: 160, overdue: true })]);
		const lines = renderJobsWidgetLines(theme, projection, 80);
		expect(lines[1]?.toLowerCase()).toContain("overdue");
		expect(lines[1]).toContain("100%"); // clamped, same as ci_wait's own overrun handling
	});

	it("never produces a line wider than the given width, across several widths", () => {
		const projection = buildJobsWidgetProjection([
			row({ backend: "jenkins-auto", jobRef: "ocp-baremetal-ipi-deployment-with-a-very-long-name", runId: "40531", progressPercent: 55 }),
		]);
		for (const width of [20, 40, 80, 120]) {
			const lines = renderJobsWidgetLines(theme, projection, width);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});

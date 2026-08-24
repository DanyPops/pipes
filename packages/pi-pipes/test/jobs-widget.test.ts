import { describe, expect, it } from "bun:test";
import { buildJobsWidgetProjection, type JobsWidgetRow } from "../src/jobs-widget.ts";

function row(overrides: Partial<JobsWidgetRow> = {}): JobsWidgetRow {
	return { backend: "gh", jobRef: "job", runId: "1", status: "running", ...overrides };
}

describe("buildJobsWidgetProjection", () => {
	it("reports total as the number of subscribed runs given", () => {
		const projection = buildJobsWidgetProjection([row({ runId: "1" }), row({ runId: "2" })]);
		expect(projection.total).toBe(2);
		expect(projection.rows).toHaveLength(2);
	});

	it("is empty (total 0, no rows) when nothing is subscribed", () => {
		const projection = buildJobsWidgetProjection([]);
		expect(projection.total).toBe(0);
		expect(projection.rows).toEqual([]);
	});

	it("orders rows deterministically by backend/jobRef/runId, not whatever order the pool happened to return them (ci.pool's own SELECT carries no ORDER BY)", () => {
		const projection = buildJobsWidgetProjection([
			row({ backend: "jenkins", jobRef: "b", runId: "1" }),
			row({ backend: "gh", jobRef: "z", runId: "1" }),
			row({ backend: "gh", jobRef: "a", runId: "1" }),
		]);
		expect(projection.rows.map((r) => `${r.backend}/${r.jobRef}`)).toEqual(["gh/a", "gh/z", "jenkins/b"]);
	});

	it("preserves every row's own fields unchanged, including progressPercent/overdue when present and absent when not", () => {
		const projection = buildJobsWidgetProjection([
			row({ runId: "1", progressPercent: 42, overdue: false }),
			row({ runId: "2" }), // no progress data at all -- e.g. a GitLab run
		]);
		expect(projection.rows[0]?.progressPercent).toBe(42);
		expect(projection.rows[1]?.progressPercent).toBeUndefined();
	});

	it("preserves a row's url unchanged when present, and leaves it undefined when the backend has none", () => {
		const projection = buildJobsWidgetProjection([
			row({ runId: "1", url: "https://example.test/runs/1" }),
			row({ runId: "2" }), // no url -- e.g. a backend that never reported one
		]);
		expect(projection.rows[0]?.url).toBe("https://example.test/runs/1");
		expect(projection.rows[1]?.url).toBeUndefined();
	});
});

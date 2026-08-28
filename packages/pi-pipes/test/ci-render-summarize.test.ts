import { describe, expect, it } from "bun:test";
import { clampDisplayPercent, effectiveWatchPercent, isTerminalWatchStatus, summarize } from "../src/ci-render.ts";

/** A no-op theme: wraps text with [color:...] markers so assertions can check both text and color choice. bold is a passthrough. */
const theme = { fg: (color: string, text: string) => `[${color}:${text}]`, bold: (text: string) => text };

describe("summarize: ci.help", () => {
	it("lists backend count, names, capabilities, and pipeline presets", () => {
		const data = {
			backends: [
				{ name: "github", capabilities: "trigger history stages artifacts" },
				{ name: "gitlab", capabilities: "unconfigured" },
			],
			pipelines: ["deploy"],
		};
		const text = summarize(data, theme);
		expect(text).toContain("2 backend(s)");
		expect(text).toContain("github");
		expect(text).toContain("gitlab");
		expect(text).toContain("Pipelines: deploy");
	});
});

describe("summarize: ci.presets (bookmarked job templates)", () => {
	it("lists each preset's name, backend, and step job names", () => {
		const data = {
			presets: [
				{ name: "deploy-prod", backend: "jenkins-ci", steps: [{ jobName: "build" }, { jobName: "deploy", params: { env: "prod" } }] },
			],
		};
		const text = summarize(data, theme);
		expect(text).toContain("1 preset(s)");
		expect(text).toContain("deploy-prod");
		expect(text).toContain("jenkins-ci");
		expect(text).toContain("build, deploy");
	});

	it("reports no presets plainly rather than an empty count line", () => {
		expect(summarize({ presets: [] }, theme)).toContain("No bookmarked presets yet.");
	});

	it("renders ci.presets.set's echoed-back preset as a bookmark confirmation", () => {
		const data = { preset: { name: "deploy-prod", backend: "jenkins-ci", steps: [{ jobName: "build" }] } };
		const text = summarize(data, theme);
		expect(text).toContain("Bookmarked");
		expect(text).toContain("deploy-prod");
		expect(text).toContain("jenkins-ci");
	});

	it("renders ci.presets.remove's removed:true as a confirmation", () => {
		expect(summarize({ removed: true }, theme)).toContain("Removed");
	});

	it("renders ci.presets.remove's removed:false distinctly from a successful removal", () => {
		const text = summarize({ removed: false }, theme);
		expect(text).toContain("No such preset");
		expect(text).not.toContain("Removed");
	});
});

describe("summarize: ci.status", () => {
	it("renders a pipelineRun with per-step status glyphs", () => {
		const data = {
			pipelineRun: {
				pipeline: "deploy",
				status: "success",
				steps: [
					{ jobName: "build", status: "success" },
					{ jobName: "test", status: "running" },
				],
			},
		};
		const text = summarize(data, theme);
		expect(text).toContain("deploy");
		expect(text).toContain("build");
		expect(text).toContain("test");
	});

	it("renders a direct verdict with backend/jobRef/runId and failure classification", () => {
		const data = {
			verdict: {
				check: { backend: "github", jobRef: "ci.yml", runId: "42", status: "failure" },
				failure: { classification: "test_failure", failedJob: "unit-tests" },
			},
		};
		const text = summarize(data, theme);
		expect(text).toContain("github/ci.yml");
		expect(text).toContain("#42");
		expect(text).toContain("test_failure");
		expect(text).toContain("unit-tests");
	});

	it("renders a passing verdict without a failure section", () => {
		const data = { verdict: { check: { backend: "github", jobRef: "ci.yml", runId: "1", status: "success" } } };
		const text = summarize(data, theme);
		expect(text).toContain("success");
		expect(text).not.toContain("undefined");
	});
});

describe("summarize: ci.trigger", () => {
	it("renders a direct TriggerResult with the resolved buildNumber", () => {
		const data = { result: { backend: "gitlab", jobRef: "deploy", buildNumber: "99", queueId: "q1" } };
		const text = summarize(data, theme);
		expect(text).toContain("Triggered");
		expect(text).toContain("gitlab/deploy");
		expect(text).toContain("#99");
	});

	it("falls back to the queueId when buildNumber hasn't resolved yet", () => {
		const data = { result: { backend: "jenkins", jobRef: "build", queueId: "q2" } };
		const text = summarize(data, theme);
		expect(text).toContain("#q2");
	});
});

describe("summarize: ci.wait", () => {
	it("renders a WatchStatus with progress percent and overdue flag", () => {
		const data = {
			buildNumber: "1",
			status: "running",
			progressPercent: 66.6,
			elapsedMs: 1000,
			estimatedMs: 1500,
			overdue: true,
			jobRef: "job",
			backend: "gh",
		};
		const text = summarize(data, theme);
		expect(text).toContain("#1");
		expect(text).toContain("67%");
		expect(text).toContain("overdue");
	});

	it("renders the bare opaqueRef-resolve form with just a buildNumber", () => {
		const data = { buildNumber: "5" };
		const text = summarize(data, theme);
		expect(text).toContain("Resolved to");
		expect(text).toContain("#5");
	});

	it("clamps a run that overran its estimated duration to 100%, instead of a nonsensical 111%", () => {
		const data = { buildNumber: "1", status: "running", progressPercent: 111, overdue: true, jobRef: "job", backend: "gh" };
		const text = summarize(data, theme);
		expect(text).toContain("100%");
		expect(text).not.toContain("111%");
	});

	it("shows 100% for a terminal success/failure/aborted run, not its raw actual-vs-estimated ratio", () => {
		// A run that finished faster than its estimated duration reports a real progressPercent well
		// under 100 -- meaningful server-side, but reads as "still not done" next to a ✓ glyph.
		for (const status of ["success", "failure", "aborted", "not_found"]) {
			const text = summarize({ buildNumber: "1", status, progressPercent: 92, overdue: false }, theme);
			expect(text).toContain("100%");
			expect(text).not.toContain("92%");
		}
	});

	it("still shows the raw ratio, not 100%, for a non-terminal (running/pending) status", () => {
		for (const status of ["running", "pending"]) {
			const text = summarize({ buildNumber: "1", status, progressPercent: 42, overdue: false }, theme);
			expect(text).toContain("42%");
		}
	});

	it("keeps the overdue flag visible on a terminal run even though the shown percent is forced to 100%", () => {
		const text = summarize({ buildNumber: "1", status: "success", progressPercent: 160, overdue: true }, theme);
		expect(text).toContain("100%");
		expect(text).toContain("overdue");
	});

	it("prefers an explicit displayPercentOverride over the raw WatchStatus.progressPercent", () => {
		const data = { buildNumber: "1", status: "running", progressPercent: 90, overdue: false };
		const text = summarize(data, theme, 42.4);
		expect(text).toContain("42%");
		expect(text).not.toContain("90%");
	});

	it("appends a streamed tail preview's last lines when present", () => {
		const data = {
			buildNumber: "1",
			status: "running",
			progressPercent: 50,
			overdue: false,
			tail: { text: "line1\nline2\nline3\nline4\nline5\nline6\nline7", truncated: false },
		};
		const text = summarize(data, theme);
		expect(text).toContain("line7");
		expect(text).toContain("line3"); // within the last 5 lines
		expect(text).not.toContain("line1"); // older than the preview window
		expect(text).toContain("..."); // more lines exist than fit the preview
	});

	it("renders a short tail preview without a truncation marker when everything fits", () => {
		const data = {
			buildNumber: "1",
			status: "success",
			progressPercent: 100,
			overdue: false,
			tail: { text: "only one line", truncated: false },
		};
		const text = summarize(data, theme);
		expect(text).toContain("only one line");
		expect(text).not.toContain("...");
	});

	it("renders no tail section at all when tail is absent, matching the pre-streaming shape", () => {
		const data = { buildNumber: "1", status: "success", progressPercent: 100, overdue: false };
		const text = summarize(data, theme);
		expect(text).not.toContain("undefined");
	});
});

describe("summarize: ci.cancel", () => {
	it("renders a cancellation confirmation with the run id", () => {
		const text = summarize({ status: "cancelled", runId: "7" }, theme);
		expect(text).toContain("Cancelled");
		expect(text).toContain("#7");
	});
});

describe("summarize: artifacts and rerun", () => {
	it("summarizes artifact lists, archive entries, and extracted content", () => {
		expect(summarize({ artifacts: [{ name: "evidence" }] }, theme)).toContain("1 artifact(s)");
		expect(summarize({ entries: [{ name: "report.json" }], truncated: true }, theme)).toContain("truncated");
		expect(summarize({ text: "{}", bytes: 2, truncated: false }, theme)).toContain("2 UTF-8 artifact byte(s)");
	});

	it("renders a rerun confirmation with the exact run id", () => {
		const text = summarize({ status: "accepted", runId: "42" }, theme);
		expect(text).toContain("Rerun accepted");
		expect(text).toContain("#42");
	});
});

describe("summarize: ci.log / ci.tail", () => {
	it("renders a LogResult's line count and flags", () => {
		const text = summarize({ lines: ["a", "b"], totalLines: 2, truncated: true, filtered: true }, theme);
		expect(text).toContain("2 line(s)");
		expect(text).toContain("truncated");
		expect(text).toContain("filtered");
	});

	it("renders a tail result's status, run id, and token budget", () => {
		const text = summarize(
			{ runId: "3", status: "success", text: "log text", truncated: false, totalTokens: 500, outputTokens: 500 },
			theme,
		);
		expect(text).toContain("#3");
		expect(text).toContain("500 tok");
	});
});

describe("summarize: ci.search / ci.downstream / ci.pool", () => {
	it("renders a build count for ci.search's builds array", () => {
		expect(summarize({ builds: [{ id: "1" }, { id: "2" }, { id: "3" }] }, theme)).toContain("3 run(s)");
	});

	it("renders a run count for ci.downstream's runs array", () => {
		expect(summarize({ runs: [{ id: "1" }] }, theme)).toContain("1 run(s)");
	});

	it("flags a truncated ci.search result -- the search gave up early, this isn't necessarily every match", () => {
		const text = summarize({ builds: [{ id: "1" }], truncated: true }, theme);
		expect(text).toContain("1 run(s)");
		expect(text.toLowerCase()).toContain("stopped early");
	});

	it("says nothing extra for a complete (non-truncated) ci.search result", () => {
		const text = summarize({ builds: [{ id: "1" }], truncated: false }, theme);
		expect(text.toLowerCase()).not.toContain("stopped early");
	});
});

describe("summarize: ci.discover", () => {
	it("renders each repo, flagging private ones", () => {
		const text = summarize(
			{
				repos: [
					{ name: "pipes", fullName: "DanyPops/pipes", private: false },
					{ name: "secrets-repo", fullName: "DanyPops/secrets-repo", private: true },
				],
			},
			theme,
		);
		expect(text).toContain("2 repo(s):");
		expect(text).toContain("pipes");
		expect(text).toContain("secrets-repo");
		expect(text).toContain("(private)");
	});

	it("renders 'No repos found.' for an empty repos array, not a bare '0 repo(s):' header", () => {
		expect(summarize({ repos: [] }, theme)).toContain("No repos found.");
	});

	it("renders each workflow's file name and display name/state", () => {
		const text = summarize({ workflows: [{ name: "Publish", fileName: "publish.yml", state: "active" }] }, theme);
		expect(text).toContain("1 workflow(s):");
		expect(text).toContain("publish.yml");
		expect(text).toContain("Publish");
		expect(text).toContain("active");
	});

	it("renders 'No workflows found.' for an empty workflows array", () => {
		expect(summarize({ workflows: [] }, theme)).toContain("No workflows found.");
	});
});

describe("summarize: ci.subscribe / ci.unsubscribe", () => {
	it("renders a subscribe confirmation", () => {
		expect(summarize({ subscribed: true }, theme)).toContain("Subscribed");
	});

	it("renders an unsubscribe confirmation", () => {
		expect(summarize({ unsubscribed: true }, theme)).toContain("Unsubscribed");
	});
});

describe("summarize: ci.stages", () => {
	it("renders a stage count", () => {
		expect(summarize({ stages: [{ id: "s1" }, { id: "s2" }] }, theme)).toContain("2 stage(s)");
	});
});

describe("summarize: ci.chain", () => {
	it("renders a CIRunNode's own status/name plus a downstream child count", () => {
		const text = summarize(
			{ jobRef: "build", runId: "1", name: "build #1", status: "success", children: [{ jobRef: "deploy", runId: "2" }] },
			theme,
		);
		expect(text).toContain("build #1");
		expect(text).toContain("1 downstream");
	});
});

describe("summarize: fallback", () => {
	it("never throws on an unrecognized shape and returns something reasonable", () => {
		expect(() => summarize({ somethingUnexpected: true }, theme)).not.toThrow();
		expect(summarize(null, theme)).toBe("null");
	});
});

describe("clampDisplayPercent", () => {
	it("passes an in-range value through unchanged", () => {
		expect(clampDisplayPercent(42.4)).toBe(42.4);
	});

	it("clamps below 0 up to 0 and above 100 down to 100", () => {
		expect(clampDisplayPercent(-5)).toBe(0);
		expect(clampDisplayPercent(111)).toBe(100);
	});
});

describe("isTerminalWatchStatus", () => {
	it("is true for every settled RunStatus", () => {
		for (const status of ["success", "failure", "aborted", "not_found"]) expect(isTerminalWatchStatus(status)).toBe(true);
	});

	it("is false while still in flight", () => {
		for (const status of ["running", "pending"]) expect(isTerminalWatchStatus(status)).toBe(false);
	});
});

describe("effectiveWatchPercent", () => {
	it("forces a terminal status to 100 regardless of the raw actual-vs-estimated ratio", () => {
		expect(effectiveWatchPercent("success", 42)).toBe(100);
		expect(effectiveWatchPercent("failure", 160)).toBe(100);
	});

	it("clamps but otherwise passes a non-terminal status's raw percent through", () => {
		expect(effectiveWatchPercent("running", 42.4)).toBe(42.4);
		expect(effectiveWatchPercent("running", 160)).toBe(100);
		expect(effectiveWatchPercent("running", -5)).toBe(0);
	});
});

import { describe, expect, it } from "bun:test";
import { summarize } from "../src/ci-tool.ts";

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
		const data = { presets: [{ name: "deploy-prod", backend: "jenkins-ci", steps: [{ jobName: "build" }, { jobName: "deploy", params: { env: "prod" } }] }] };
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
		const data = { pipelineRun: { pipeline: "deploy", status: "success", steps: [{ jobName: "build", status: "success" }, { jobName: "test", status: "running" }] } };
		const text = summarize(data, theme);
		expect(text).toContain("deploy");
		expect(text).toContain("build");
		expect(text).toContain("test");
	});

	it("renders a direct verdict with backend/jobRef/runId and failure classification", () => {
		const data = { verdict: { check: { backend: "github", jobRef: "ci.yml", runId: "42", status: "failure" }, failure: { classification: "test_failure", failedJob: "unit-tests" } } };
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
		const data = { buildNumber: "1", status: "running", progressPercent: 66.6, elapsedMs: 1000, estimatedMs: 1500, overdue: true, jobRef: "job", backend: "gh" };
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
		const data = { buildNumber: "1", status: "success", progressPercent: 100, overdue: false, tail: { text: "only one line", truncated: false } };
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

describe("summarize: ci.log / ci.tail", () => {
	it("renders a LogResult's line count and flags", () => {
		const text = summarize({ lines: ["a", "b"], totalLines: 2, truncated: true, filtered: true }, theme);
		expect(text).toContain("2 line(s)");
		expect(text).toContain("truncated");
		expect(text).toContain("filtered");
	});

	it("renders a tail result's status, run id, and token budget", () => {
		const text = summarize({ runId: "3", status: "success", text: "log text", truncated: false, totalTokens: 500, outputTokens: 500 }, theme);
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
		const text = summarize({ jobRef: "build", runId: "1", name: "build #1", status: "success", children: [{ jobRef: "deploy", runId: "2" }] }, theme);
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

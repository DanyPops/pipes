/**
 * pi-pipes' own domain config over @danypops/vehicle-client-pi's generic AgentPollTicker -- the
 * vanish/reminder/throttle state machine itself is exhaustively covered by that package's own
 * test/agent-poll-ticker.test.ts now (see ~/Projects/vehicle). What's tested here is only what's
 * genuinely pi-pipes-specific: the CI job row key format and message wording, and that
 * createJobTicker() really does wire up to the shared ticker (not a full re-test of its state
 * machine).
 */
import { describe, expect, it } from "bun:test";
import { createJobTicker, resolveJobTickerReminderIntervalMs } from "../src/job-ticker.ts";
import type { JobsWidgetRow } from "../src/jobs-widget.ts";

function row(overrides: Partial<JobsWidgetRow> = {}): JobsWidgetRow {
	return {
		backend: "jenkins-auto",
		jobRef: "ocp-baremetal-ipi-deployment",
		runId: "40531",
		status: "running",
		...overrides,
	};
}

describe("createJobTicker", () => {
	it("says nothing on the very first tick -- delegates the no-baseline-yet rule to the shared AgentPollTicker", () => {
		const ticker = createJobTicker({ now: () => 0 });
		expect(ticker.tick([row()])).toBeUndefined();
	});

	it("reports a vanished job by its backend/jobRef/runId key, asking the agent to probe rather than guessing its result", () => {
		let now = 0;
		const ticker = createJobTicker({ now: () => now });
		ticker.tick([row()]); // baseline
		now += 1;

		const message = ticker.tick([]);

		expect(message).toContain("jenkins-auto/ocp-baremetal-ipi-deployment/40531");
		expect(message?.toLowerCase()).toContain("finished");
		expect(message?.toLowerCase()).toContain("probe");
	});

	it("reports every vanished job's key together in one message", () => {
		let now = 0;
		const ticker = createJobTicker({ now: () => now });
		ticker.tick([row(), row({ jobRef: "other-job", runId: "99" })]);
		now += 1;

		const message = ticker.tick([]);

		expect(message).toContain("jenkins-auto/ocp-baremetal-ipi-deployment/40531");
		expect(message).toContain("jenkins-auto/other-job/99");
	});

	it("reports a still-in-flight reminder once reminderIntervalMs has elapsed with nothing vanished", () => {
		let now = 0;
		const ticker = createJobTicker({ now: () => now, reminderIntervalMs: 1000 });
		ticker.tick([row()]);
		now = 1000;

		const message = ticker.tick([row()]);

		expect(message).toContain("jenkins-auto/ocp-baremetal-ipi-deployment/40531");
		expect(message?.toLowerCase()).toContain("probe");
		expect(message?.toLowerCase()).not.toContain("finished");
	});

	it("defaults reminderIntervalMs to resolveJobTickerReminderIntervalMs()'s own value", () => {
		let now = 0;
		const ticker = createJobTicker({ now: () => now });
		ticker.tick([row()]);
		now = 15_000; // well under the 5-minute default -- must still be quiet
		expect(ticker.tick([row()])).toBeUndefined();
	});
});

describe("resolveJobTickerReminderIntervalMs", () => {
	it("defaults to 5 minutes when unset", () => {
		expect(resolveJobTickerReminderIntervalMs(undefined)).toBe(5 * 60_000);
	});

	it("parses a valid positive override", () => {
		expect(resolveJobTickerReminderIntervalMs("60000")).toBe(60_000);
	});

	it("falls back to the default for a non-numeric or non-positive override", () => {
		expect(resolveJobTickerReminderIntervalMs("not-a-number")).toBe(5 * 60_000);
		expect(resolveJobTickerReminderIntervalMs("0")).toBe(5 * 60_000);
		expect(resolveJobTickerReminderIntervalMs("-5")).toBe(5 * 60_000);
	});
});

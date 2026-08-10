/**
 * TDD: written before src/job-ticker.ts exists. JobTicker is the pure decision step behind "wire
 * the job overlay to notify the agent" -- given each refresh's freshly fetched rows, it decides
 * whether this tick is worth interrupting the agent for, and returns the message text to send (or
 * undefined). No I/O, no ExtensionAPI, no timers -- see jobs-overlay.ts for the stateful class that
 * actually calls pi.sendUserMessage with whatever this returns.
 */
import { describe, expect, it } from "bun:test";
import { JobTicker, resolveJobTickerReminderIntervalMs } from "../src/job-ticker.ts";
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

describe("JobTicker", () => {
	it("says nothing on the very first tick, even with active rows -- no prior baseline to diff against, and too soon for a reminder", () => {
		const ticker = new JobTicker({ now: () => 0 });
		expect(ticker.tick([row()])).toBeUndefined();
	});

	it("says nothing when there is nothing subscribed and nothing was ever subscribed", () => {
		const ticker = new JobTicker({ now: () => 0 });
		expect(ticker.tick([])).toBeUndefined();
		expect(ticker.tick([])).toBeUndefined();
	});

	it("immediately reports a job that disappears between two ticks, regardless of elapsed time", () => {
		let now = 0;
		const ticker = new JobTicker({ now: () => now });
		ticker.tick([row()]); // baseline: tracking jenkins-auto/ocp-baremetal-ipi-deployment #40531

		now += 1; // barely any time has passed -- must not matter for a vanish report
		const message = ticker.tick([]);

		expect(message).toBeDefined();
		expect(message).toContain("jenkins-auto/ocp-baremetal-ipi-deployment/40531");
		expect(message?.toLowerCase()).toContain("finished");
	});

	it("reports every job that vanished in the same tick, not just one", () => {
		let now = 0;
		const ticker = new JobTicker({ now: () => now });
		ticker.tick([row(), row({ jobRef: "other-job", runId: "99" })]);

		now += 1;
		const message = ticker.tick([]);

		expect(message).toContain("jenkins-auto/ocp-baremetal-ipi-deployment/40531");
		expect(message).toContain("jenkins-auto/other-job/99");
	});

	it("does not report a reminder before reminderIntervalMs has elapsed since the ticker started", () => {
		let now = 0;
		const ticker = new JobTicker({ now: () => now, reminderIntervalMs: 1000 });
		ticker.tick([row()]); // first tick: no baseline yet

		now = 999;
		expect(ticker.tick([row()])).toBeUndefined();
	});

	it("reports a still-in-flight reminder once reminderIntervalMs has elapsed with no vanish to report", () => {
		let now = 0;
		const ticker = new JobTicker({ now: () => now, reminderIntervalMs: 1000 });
		ticker.tick([row()]);

		now = 1000;
		const message = ticker.tick([row()]);

		expect(message).toBeDefined();
		expect(message).toContain("jenkins-auto/ocp-baremetal-ipi-deployment/40531");
		expect(message?.toLowerCase()).toContain("progress");
	});

	it("resets the reminder clock after firing -- does not fire again on the very next tick", () => {
		let now = 0;
		const ticker = new JobTicker({ now: () => now, reminderIntervalMs: 1000 });
		ticker.tick([row()]);
		now = 1000;
		expect(ticker.tick([row()])).toBeDefined();

		now = 1001;
		expect(ticker.tick([row()])).toBeUndefined();

		now = 2000;
		expect(ticker.tick([row()])).toBeDefined();
	});

	it("prefers reporting a vanish over a reminder when both would otherwise fire on the same tick", () => {
		let now = 0;
		const ticker = new JobTicker({ now: () => now, reminderIntervalMs: 1000 });
		ticker.tick([row(), row({ jobRef: "other-job", runId: "99" })]);

		now = 1000; // reminder is also due now
		const message = ticker.tick([row({ jobRef: "other-job", runId: "99" })]); // one of the two vanished

		expect(message).toContain("finished");
		expect(message).toContain("jenkins-auto/ocp-baremetal-ipi-deployment/40531");
		expect(message).not.toContain("other-job"); // still running -- not part of the vanish report
	});

	it("defaults to a multi-minute reminder interval so a long-running job does not nag every widget poll", () => {
		const ticker = new JobTicker({ now: () => 0 });
		// 15s (JOBS_WIDGET_POLL_INTERVAL_MS) later, well under any sane default, must still be quiet.
		let now = 0;
		const t2 = new JobTicker({ now: () => now });
		t2.tick([row()]);
		now = 15_000;
		expect(t2.tick([row()])).toBeUndefined();
		void ticker;
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

import { describe, expect, it } from "bun:test";
import { createJobTicker, type JobCompletion, resolveJobTickerReminderIntervalMs } from "../src/job-ticker.ts";
import type { JobsWidgetRow } from "../src/jobs-widget.ts";

function row(overrides: Partial<JobsWidgetRow> = {}): JobsWidgetRow {
	return {
		backend: "jenkins-auto",
		jobRef: "deployment",
		runId: "40531",
		status: "running",
		...overrides,
	};
}

async function completion(value: JobsWidgetRow): Promise<JobCompletion> {
	return { ...value, status: "success", result: "SUCCESS", url: "https://ci.example/run/40531" };
}

describe("createJobTicker", () => {
	it("is quiet on the initial observation", async () => {
		const ticker = createJobTicker({ now: () => 0 });
		expect(await ticker.tick([row()], completion)).toBeUndefined();
	});

	it("resolves a vanished job and requests an immediate turn", async () => {
		const ticker = createJobTicker({ now: () => 0 });
		await ticker.tick([row()], completion);

		const notice = await ticker.tick([], completion);

		expect(notice?.content).toContain("jenkins-auto/deployment/40531: success (SUCCESS)");
		expect(notice?.content).toContain("https://ci.example/run/40531");
		expect(notice?.triggerTurn).toBe(true);
	});

	it("retries a failed terminal lookup on the next poll", async () => {
		const ticker = createJobTicker({ now: () => 0 });
		await ticker.tick([row()], completion);
		let attempts = 0;
		const flaky = async (value: JobsWidgetRow) => {
			attempts++;
			if (attempts === 1) throw new Error("temporary backend failure");
			return completion(value);
		};

		expect(await ticker.tick([], flaky)).toBeUndefined();
		expect((await ticker.tick([], flaky))?.content).toContain("success");
	});

	it("deduplicates push and polling completion delivery", async () => {
		const ticker = createJobTicker({ now: () => 0 });
		await ticker.tick([row()], completion);
		expect(ticker.completion(await completion(row()))).toBeDefined();
		expect(ticker.completion(await completion(row()))).toBeUndefined();
		expect(await ticker.tick([], completion)).toBeUndefined();
	});

	it("emits throttled in-flight reminders without triggering a turn", async () => {
		let now = 0;
		const ticker = createJobTicker({ now: () => now, reminderIntervalMs: 1000 });
		await ticker.tick([row()], completion);
		now = 1000;

		const notice = await ticker.tick([row()], completion);

		expect(notice?.content).toContain("still in flight");
		expect(notice?.triggerTurn).toBe(false);
	});
});

describe("resolveJobTickerReminderIntervalMs", () => {
	it("defaults to five minutes", () => {
		expect(resolveJobTickerReminderIntervalMs(undefined)).toBe(5 * 60_000);
	});

	it("accepts a positive override", () => {
		expect(resolveJobTickerReminderIntervalMs("60000")).toBe(60_000);
	});

	it("rejects invalid overrides", () => {
		expect(resolveJobTickerReminderIntervalMs("not-a-number")).toBe(5 * 60_000);
		expect(resolveJobTickerReminderIntervalMs("0")).toBe(5 * 60_000);
		expect(resolveJobTickerReminderIntervalMs("-5")).toBe(5 * 60_000);
	});
});

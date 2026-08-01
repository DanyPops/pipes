import { describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { waitAndStreamTail } from "../src/ci-wait-stream.ts";
import type { PipesClient } from "../src/daemon-client.ts";

/** Scripted fake: each ci.wait call returns the next queued status; ci.tail always returns a fresh tail keyed to the call count. */
function fakeClient(statuses: string[]): PipesClient & { waitCalls: unknown[]; tailCalls: unknown[] } {
	const waitQueue = [...statuses];
	const waitCalls: unknown[] = [];
	const tailCalls: unknown[] = [];
	return {
		waitCalls,
		tailCalls,
		call: (async (operation: string, input: Record<string, unknown>) => {
			if (operation === "ci.wait") {
				waitCalls.push(input);
				const status = waitQueue.length > 1 ? waitQueue.shift() : (waitQueue[0] ?? "success");
				return {
					buildNumber: input.runId,
					jobRef: input.jobRef,
					backend: input.backend,
					status,
					progressPercent: 50,
					elapsedMs: 1000,
					estimatedMs: 2000,
					overdue: false,
				};
			}
			if (operation === "ci.tail") {
				tailCalls.push(input);
				return { text: `log line ${tailCalls.length}`, truncated: false, totalTokens: 10, outputTokens: 10 };
			}
			throw new Error(`unhandled op in test fake: ${operation}`);
		}) as PipesClient["call"],
		health: async () => ({ ok: true, version: "test" }),
	};
}

describe("waitAndStreamTail", () => {
	it("stops after one tick when the run is already terminal", async () => {
		const client = fakeClient(["success"]);
		const updates: unknown[] = [];

		const result = await waitAndStreamTail(client, { backend: "gh", jobRef: "job", runId: "1" }, (patch) => updates.push(patch), undefined);

		expect(client.waitCalls).toHaveLength(1);
		expect(client.tailCalls).toHaveLength(1);
		expect(updates).toHaveLength(1);
		expect(result.status).toBe("success");
		expect((result.tail as { text: string }).text).toBe("log line 1");
	});

	it("keeps polling and streaming until a terminal status is reached", async () => {
		const client = fakeClient(["running", "running", "success"]);
		const updates: Array<AgentToolResult<{ result: Record<string, unknown> }>> = [];

		const result = await waitAndStreamTail(
			client,
			{ backend: "gh", jobRef: "job", runId: "1" },
			(patch) => updates.push(patch as AgentToolResult<{ result: Record<string, unknown> }>),
			undefined,
		);

		expect(client.waitCalls).toHaveLength(3);
		expect(client.tailCalls).toHaveLength(3);
		expect(updates).toHaveLength(3);
		expect(result.status).toBe("success");
		// Each intermediate update carries that tick's own tail snapshot, not a stale first one.
		// updates.length is already asserted above, so index access here is genuinely safe.
		expect((updates[0]!.details.result as Record<string, unknown>).tail).toEqual({
			text: "log line 1",
			truncated: false,
			totalTokens: 10,
			outputTokens: 10,
		});
		expect((updates[2]!.details.result as Record<string, unknown>).tail).toEqual({
			text: "log line 3",
			truncated: false,
			totalTokens: 10,
			outputTokens: 10,
		});
	});

	it("stops once the overall timeout elapses, even if never terminal", async () => {
		const client = fakeClient(["running", "running", "running", "running", "running"]);
		let clock = 0;
		const now = () => clock;
		// Each tick "takes" 25s of simulated time -- more than the 20s per-tick cap, so the
		// deadline (60s total) is what actually stops the loop, not a fixed tick count.
		const advancingClient: PipesClient = {
			...client,
			call: (async (operation: string, input: Record<string, unknown>) => {
				clock += 25_000;
				return client.call(operation, input);
			}) as PipesClient["call"],
		};

		const result = await waitAndStreamTail(
			advancingClient,
			{ backend: "gh", jobRef: "job", runId: "1", timeoutS: 60 },
			undefined,
			undefined,
			now,
		);

		expect(result.status).toBe("running");
		expect(client.waitCalls.length).toBeLessThan(5);
		expect(client.waitCalls.length).toBeGreaterThan(0);
	});

	it("stops after the current tick once the signal is aborted, not mid-flight", async () => {
		const client = fakeClient(["running", "running", "running"]);
		const controller = new AbortController();
		let ticks = 0;
		const trackedClient: PipesClient = {
			...client,
			call: (async (operation: string, input: Record<string, unknown>) => {
				if (operation === "ci.wait") {
					ticks++;
					if (ticks === 2) controller.abort();
				}
				return client.call(operation, input);
			}) as PipesClient["call"],
		};

		const result = await waitAndStreamTail(trackedClient, { backend: "gh", jobRef: "job", runId: "1" }, undefined, controller.signal);

		expect(ticks).toBe(2);
		expect(result.status).toBe("running");
	});

	it("passes maxTokens through to ci.tail on every tick", async () => {
		const client = fakeClient(["success"]);

		await waitAndStreamTail(client, { backend: "gh", jobRef: "job", runId: "1", maxTokens: 250 }, undefined, undefined);

		expect(client.tailCalls[0]).toEqual({ backend: "gh", jobRef: "job", runId: "1", maxTokens: 250 });
	});

	it("returns {} without calling anything when the signal is already aborted before the first tick", async () => {
		const client = fakeClient(["running"]);
		const controller = new AbortController();
		controller.abort();

		const result = await waitAndStreamTail(client, { backend: "gh", jobRef: "job", runId: "1" }, undefined, controller.signal);

		expect(result).toEqual({});
		expect(client.waitCalls).toHaveLength(0);
	});
});

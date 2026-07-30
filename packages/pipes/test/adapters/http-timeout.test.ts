import { describe, expect, it } from "bun:test";
import { HttpTimeoutError, withTimeout } from "../../src/adapters/http-timeout.ts";

describe("withTimeout", () => {
	it("passes through a response that resolves before the deadline", async () => {
		const response = new Response("ok");
		const wrapped = withTimeout(async () => response, 50);

		await expect(wrapped("https://example.com")).resolves.toBe(response);
	});

	it("aborts and throws HttpTimeoutError when the request never settles", async () => {
		const wrapped = withTimeout(() => new Promise<Response>(() => {}), 10);

		await expect(wrapped("https://example.com/hangs")).rejects.toThrow(HttpTimeoutError);
	});

	it("lets a genuine fetch failure (not a timeout) surface unchanged", async () => {
		const wrapped = withTimeout(async () => {
			throw new Error("DNS resolution failed");
		}, 50);

		await expect(wrapped("https://example.com")).rejects.toThrow("DNS resolution failed");
	});

	it("propagates the abort signal to the underlying fetch so it can actually stop the request", async () => {
		let receivedSignal: AbortSignal | undefined;
		const wrapped = withTimeout((_url, init) => {
			receivedSignal = init?.signal ?? undefined;
			return new Promise<Response>(() => {});
		}, 10);

		await expect(wrapped("https://example.com/hangs")).rejects.toThrow(HttpTimeoutError);
		expect(receivedSignal?.aborted).toBe(true);
	});
});

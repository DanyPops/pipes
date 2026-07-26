import { describe, expect, it } from "bun:test";
import { estimateTokens, tailByTokenBudget } from "../src/truncate.ts";

describe("estimateTokens", () => {
	it("estimates ~4 chars per token, matching pi-mono's own convention", () => {
		expect(estimateTokens("a".repeat(8))).toBe(2);
		expect(estimateTokens("a".repeat(9))).toBe(3); // ceil, not floor
		expect(estimateTokens("")).toBe(0);
	});
});

describe("tailByTokenBudget", () => {
	it("returns the full text unmodified when it already fits the budget", () => {
		const result = tailByTokenBudget("short log", 100);
		expect(result.truncated).toBe(false);
		expect(result.text).toBe("short log");
	});

	it("keeps only complete lines from the end when over budget", () => {
		const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
		const text = lines.join("\n");
		const result = tailByTokenBudget(text, 10); // 10 tokens = 40 chars budget

		expect(result.truncated).toBe(true);
		expect(text.endsWith(result.text)).toBe(true);
		expect(result.text).not.toContain("line 0\n"); // the head was dropped, not the tail
		for (const line of result.text.split("\n")) {
			expect(lines).toContain(line); // never a partial line
		}
	});

	it("falls back to a raw character slice when a single line alone exceeds the budget", () => {
		const text = "x".repeat(1000);
		const result = tailByTokenBudget(text, 10); // 40 chars budget, one line of 1000 chars

		expect(result.truncated).toBe(true);
		expect(result.text.length).toBe(40);
		expect(text.endsWith(result.text)).toBe(true);
	});

	it("reports totalTokens against the original text and outputTokens against the truncated result", () => {
		const text = "a".repeat(4000); // 1000 tokens
		const result = tailByTokenBudget(text, 100);

		expect(result.totalTokens).toBe(1000);
		expect(result.outputTokens).toBeLessThanOrEqual(100);
	});
});

import { describe, expect, it } from "bun:test";
import { findFirstUrl, openLine, statusGlyph } from "../src/ci-render.ts";

/** A no-op theme: wraps text with [color:...] markers so assertions can check both the text and the color choice. */
const theme = { fg: (color: string, text: string) => `[${color}:${text}]` };

describe("findFirstUrl", () => {
	it("finds a top-level url", () => {
		expect(findFirstUrl({ url: "https://example.test/run/1", other: "x" })).toBe("https://example.test/run/1");
	});

	it("returns undefined when there is no url anywhere", () => {
		expect(findFirstUrl({ status: "success", runId: "1" })).toBeUndefined();
	});

	it("prefers a shallower url over one nested deeper", () => {
		const data = { url: "https://example.test/top", child: { url: "https://example.test/nested" } };
		expect(findFirstUrl(data)).toBe("https://example.test/top");
	});

	it("finds a url nested inside an array of objects", () => {
		const data = { builds: [{ id: "1", url: "https://example.test/build/1" }, { id: "2" }] };
		expect(findFirstUrl(data)).toBe("https://example.test/build/1");
	});

	it("ignores an empty-string url", () => {
		expect(findFirstUrl({ url: "", child: { url: "https://example.test/real" } })).toBe("https://example.test/real");
	});

	it("handles null, primitives, and non-object input without throwing", () => {
		expect(findFirstUrl(null)).toBeUndefined();
		expect(findFirstUrl(42)).toBeUndefined();
		expect(findFirstUrl("just a string")).toBeUndefined();
		expect(findFirstUrl(undefined)).toBeUndefined();
	});

	it("is bounded and terminates on a large, deeply nested structure", () => {
		let data: Record<string, unknown> = { url: undefined };
		for (let i = 0; i < 5000; i++) {
			data = { child: data, siblings: Array.from({ length: 20 }, (_, j) => ({ n: i * 20 + j })) };
		}
		expect(() => findFirstUrl(data)).not.toThrow();
	});
});

describe("statusGlyph", () => {
	it("maps known statuses to a distinct color", () => {
		expect(statusGlyph("success", theme)).toContain("success");
		expect(statusGlyph("failure", theme)).toContain("error");
		expect(statusGlyph("running", theme)).toContain("warning");
	});

	it("falls back to a dim rendering of an unknown or missing status", () => {
		expect(statusGlyph("some_future_status", theme)).toBe("[dim:some_future_status]");
		expect(statusGlyph(undefined, theme)).toBe("[dim:unknown]");
	});
});

describe("openLine", () => {
	it("includes the raw URL as visible text, so it reads correctly even without OSC 8 support", () => {
		const line = openLine("https://example.test/run/1", theme);
		expect(line).toContain("https://example.test/run/1");
		expect(line).toContain("Open:");
	});
});

import { describe, expect, it } from "bun:test";
import { renderResultText } from "../src/ci-render.ts";

/** A no-op theme: wraps text with [color:...] markers so assertions can check both text and color choice. bold is a passthrough. */
const theme = { fg: (color: string, text: string) => `[${color}:${text}]`, bold: (text: string) => text };

describe("renderResultText: still-in-flight ci wait (isPartial)", () => {
	it("shows a bare placeholder before the first onUpdate tick has landed any data", () => {
		const result = { content: [{ type: "text" as const, text: "" }] };
		const text = renderResultText(result, true, false, theme);
		expect(text).toBe("[warning:Running...]");
	});

	it("renders the real WatchStatus+tail snapshot once a tick has landed data, instead of staying a bare placeholder", () => {
		const result = {
			content: [{ type: "text" as const, text: "" }],
			details: {
				result: {
					status: "running",
					buildNumber: "9176",
					progressPercent: 42,
					overdue: false,
					tail: { text: "line one\nline two", truncated: false },
				},
			},
		};
		const text = renderResultText(result, true, false, theme);
		expect(text).toContain("Running...");
		expect(text).toContain("#9176");
		expect(text).toContain("42%");
		expect(text).toContain("line two");
	});

	it("never reports an error while still partial, even if the eventual result errors", () => {
		const result = { content: [{ type: "text" as const, text: "" }] };
		const text = renderResultText(result, true, true, theme);
		expect(text).not.toContain("Error");
	});
});

describe("renderResultText: final result", () => {
	it("reports an error once no longer partial", () => {
		const result = { content: [{ type: "text" as const, text: "boom" }] };
		const text = renderResultText(result, false, true, theme);
		expect(text).toBe("[error:Error: boom]");
	});

	it("falls back to the plain content message when there is no structured result", () => {
		const result = { content: [{ type: "text" as const, text: "plain fallback" }] };
		expect(renderResultText(result, false, false, theme)).toBe("plain fallback");
	});

	it("renders the final structured result through summarize, without a Running prefix", () => {
		const result = {
			content: [{ type: "text" as const, text: "" }],
			details: { result: { status: "success", buildNumber: "9176", progressPercent: 100, overdue: false } },
		};
		const text = renderResultText(result, false, false, theme);
		expect(text).not.toContain("Running...");
		expect(text).toContain("#9176");
	});
});

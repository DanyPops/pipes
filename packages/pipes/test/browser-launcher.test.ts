import { describe, expect, it } from "bun:test";
import { openInBrowser } from "../src/browser-launcher.ts";

describe("openInBrowser", () => {
	it("resolves true and passes the exact URL through when the opener succeeds", async () => {
		const calls: string[] = [];
		const result = await openInBrowser("https://example.com/device", async (url) => {
			calls.push(url);
		});
		expect(result).toBe(true);
		expect(calls).toEqual(["https://example.com/device"]);
	});

	it("resolves false instead of throwing when the opener fails (headless session, no browser installed)", async () => {
		const result = await openInBrowser("https://example.com/device", async () => {
			throw new Error("spawn xdg-open ENOENT");
		});
		expect(result).toBe(false);
	});
});

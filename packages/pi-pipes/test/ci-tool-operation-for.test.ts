import { describe, expect, it } from "bun:test";
import { operationFor } from "../src/ci-tool.ts";

describe("operationFor", () => {
	it("maps most actions 1:1 onto ci.<action>", () => {
		expect(operationFor("status")).toBe("ci.status");
		expect(operationFor("trigger")).toBe("ci.trigger");
		expect(operationFor("downstream")).toBe("ci.downstream");
		expect(operationFor("discover")).toBe("ci.discover");
	});

	it("maps help onto ci.help explicitly", () => {
		expect(operationFor("help")).toBe("ci.help");
	});

	it("renames presets/bookmark/unbookmark onto the daemon's own ci.presets.* operations", () => {
		expect(operationFor("presets")).toBe("ci.presets.list");
		expect(operationFor("bookmark")).toBe("ci.presets.set");
		expect(operationFor("unbookmark")).toBe("ci.presets.remove");
	});
});

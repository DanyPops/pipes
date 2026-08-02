import { describe, expect, it } from "bun:test";
import { classifyLog } from "../../src/run/classify.ts";

describe("classifyLog", () => {
	it("classifies network errors as retryable", () => {
		expect(classifyLog("Error: connection refused")).toEqual({ classification: "network_timeout", canRetry: true });
		expect(classifyLog("dial tcp 10.0.0.1:443: i/o timeout")).toEqual({ classification: "network_timeout", canRetry: true });
	});

	it("classifies infra errors as retryable", () => {
		expect(classifyLog("container killed: OOMKilled")).toEqual({ classification: "infra_failure", canRetry: true });
		expect(classifyLog("Back-off pulling image: ImagePullBackOff")).toEqual({ classification: "infra_failure", canRetry: true });
	});

	it("classifies config errors as not retryable", () => {
		expect(classifyLog("Error: permission denied")).toEqual({ classification: "config_error", canRetry: false });
		expect(classifyLog("yaml: syntax error on line 4")).toEqual({ classification: "config_error", canRetry: false });
	});

	it("classifies test failures as not retryable", () => {
		expect(classifyLog("3 tests failed, 0 passed")).toEqual({ classification: "test_failure", canRetry: false });
		expect(classifyLog("AssertionError: expected but was 5")).toEqual({ classification: "test_failure", canRetry: false });
	});

	it("falls back to unknown, not retryable, for unrecognized logs", () => {
		expect(classifyLog("some completely unremarkable log line")).toEqual({ classification: "unknown", canRetry: false });
	});

	it("matches case-insensitively and takes the first matching rule in priority order", () => {
		// "OOMKilled" is infra; ensure it wins even embedded in a larger message that also mentions "failed".
		expect(classifyLog("Step failed: Container OOMKilled after 30s")).toEqual({ classification: "infra_failure", canRetry: true });
	});
});

import type { FailureClassification } from "./domain/ci-run.ts";

interface ClassificationRule {
	classification: FailureClassification;
	canRetry: boolean;
	patterns: string[];
}

/** Evaluated top to bottom; first match wins. Ported verbatim from conty's app/classify.go. */
const CLASSIFICATION_RULES: ClassificationRule[] = [
	{
		classification: "network_timeout",
		canRetry: true,
		patterns: [
			"connection timed out",
			"connection refused",
			"connection reset by peer",
			"i/o timeout",
			"read timeout",
			"write timeout",
			"deadline exceeded",
			"network unreachable",
			"no route to host",
			"temporary failure in name resolution",
			"dial tcp",
			"tls handshake timeout",
			"econnreset",
			"econnrefused",
			"etimedout",
		],
	},
	{
		classification: "infra_failure",
		canRetry: true,
		patterns: [
			"no space left on device",
			"out of memory",
			"oomkilled",
			"cannot allocate memory",
			"killed: 9",
			"signal: killed",
			"node is not available",
			"node not found",
			"evicted",
			"crashloopbackoff",
			"imagepullbackoff",
			"failed to pull image",
			"disk pressure",
			"memory pressure",
			"pod has been evicted",
		],
	},
	{
		classification: "config_error",
		canRetry: false,
		patterns: [
			"invalid configuration",
			"configuration error",
			"config not found",
			"missing required",
			"undefined variable",
			"syntax error",
			"parse error",
			"invalid value",
			"unknown option",
			"permission denied",
			"access denied",
			"unauthorized",
			"authentication failed",
			"certificate verify failed",
		],
	},
	{
		classification: "test_failure",
		canRetry: false,
		patterns: [
			"tests failed",
			"test failed",
			"assertion failed",
			"assertionerror",
			"expected but was",
			"failures:",
			"failed tests:",
			"build failed",
			"[fail]",
			"--- fail",
		],
	},
];

/** Inspects a build log excerpt and returns the best-fit classification and whether it's safe to retry. */
export function classifyLog(log: string): { classification: FailureClassification; canRetry: boolean } {
	const lower = log.toLowerCase();
	for (const rule of CLASSIFICATION_RULES) {
		if (rule.patterns.some((pattern) => lower.includes(pattern))) {
			return { classification: rule.classification, canRetry: rule.canRetry };
		}
	}
	return { classification: "unknown", canRetry: false };
}

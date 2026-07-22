export type RunStatus = "pending" | "running" | "success" | "failure" | "aborted" | "not_found";

export function isTerminalStatus(status: RunStatus): boolean {
	return status === "success" || status === "failure" || status === "aborted";
}

export type RunResult = "SUCCESS" | "FAILURE" | "UNSTABLE" | "ABORTED" | "";

export type FailureClassification = "network_timeout" | "config_error" | "infra_failure" | "test_failure" | "unknown";

export interface CIRunRef {
	jobRef: string;
	runId: string;
	displayName?: string;
}

export interface CIRun {
	id: string;
	name: string;
	status: RunStatus;
	result?: RunResult;
	url?: string;
	startedAt: Date;
	durationMs?: number;
	upstreamJob?: string;
	upstreamRunId?: string;
	children?: CIRunRef[];
	failureExcerpt?: string;
}

export interface CIJob {
	id: string;
	name: string;
	status: RunStatus;
	result?: RunResult;
	parentRun?: string;
	url?: string;
	startedAt: Date;
	durationMs?: number;
}

export interface CIStep {
	id: string;
	name: string;
	status: RunStatus;
	durationMs?: number;
	description?: string;
	failedLog?: string;
}

export interface CIStageNode {
	id: string;
	name: string;
	status: RunStatus;
	durationMs?: number;
	steps?: CIStep[];
}

export interface CIArtifact {
	name: string;
	path: string;
	sizeBytes?: number;
}

export interface BuildFilter {
	result?: RunResult;
	params?: Record<string, string>;
	runner?: string;
	since?: Date;
	limit?: number;
}

export const LOG_DEFAULT_TAIL_LINES = 200;
export const LOG_DEFAULT_MAX_BYTES = 50 * 1024;

export interface LogFilter {
	/** Max lines from the end; undefined means LOG_DEFAULT_TAIL_LINES, -1 means no truncation. */
	tail?: number;
	grep?: string;
}

export interface LogResult {
	lines: string[];
	totalLines: number;
	skipped?: number;
	filtered?: boolean;
	truncated?: boolean;
}


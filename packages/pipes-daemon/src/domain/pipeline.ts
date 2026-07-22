import type { RunResult, RunStatus } from "./ci-run.ts";

/** A named, reusable multi-step recipe — how a caller avoids raw backend/job/param details. */
export interface Pipeline {
	name: string;
	backend: string;
	steps: PipelineStep[];
}

export interface PipelineStep {
	jobName: string;
	params?: Record<string, string>;
}

export interface StepResult {
	jobName: string;
	runId?: string;
	status: RunStatus;
	result?: RunResult;
	startedAt?: Date;
	durationMs?: number;
	url?: string;
}

export interface PipelineRun {
	pipeline: string;
	status: RunStatus;
	steps: StepResult[];
	startedAt: Date;
	durationMs?: number;
}

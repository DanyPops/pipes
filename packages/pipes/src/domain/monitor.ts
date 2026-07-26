import type { FailureClassification, RunStatus } from "./ci-run.ts";
import type { LogResult } from "./ci-run.ts";

/** Lightweight snapshot — the input to a CIVerdict, not the answer itself. */
export interface CICheck {
	jobRef: string;
	backend: string;
	runId: string;
	status: RunStatus;
	checkedAt: Date;
	/** The backend's own web view of this run, when the adapter reports one -- lets a caller open it directly. */
	url?: string;
}

export interface TestSummary {
	total: number;
	passed: number;
	failed: number;
	skipped: number;
}

export interface FailureContext {
	failedJob?: string;
	log?: LogResult;
	classification: FailureClassification;
	canRetry: boolean;
}

/** The compact, one-call "did it pass" answer: never a raw run dump. */
export interface CIVerdict {
	check: CICheck;
	testSummary?: TestSummary;
	failure?: FailureContext;
}

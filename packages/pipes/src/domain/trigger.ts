import type { RunStatus } from "./ci-run.ts";

/**
 * Two-phase trigger result. Backends that assign a run ID synchronously
 * (GitLab, Prow) set needsResolve=false and populate runId immediately.
 * Backends with an async queue (Jenkins) or no run ID at dispatch time
 * (GitHub Actions' workflow_dispatch) set needsResolve=true and populate
 * opaqueRef with a backend-specific correlation token; call resolveReceipt
 * in a loop until needsResolve is false.
 */
export interface TriggerReceipt {
	runId?: string;
	opaqueRef?: string;
	needsResolve: boolean;
	backend: string;
	jobRef: string;
}

/** Agent-facing trigger response — queueId is the deprecated alias for opaqueRef. */
export interface TriggerResult {
	queueId?: string;
	buildNumber?: string;
	jobRef: string;
	backend: string;
	estimatedDurationMs?: number;
	pollIntervalMs?: number;
}

/** Real-time progress: percent complete against EstimateDuration, plus an overdue flag past 1.5x estimate. */
export interface WatchStatus {
	buildNumber: string;
	jobRef: string;
	backend: string;
	status: RunStatus;
	progressPercent: number;
	elapsedMs: number;
	estimatedMs: number;
	overdue: boolean;
}

/** Session-scoped: CICancel refuses to act on a run this session didn't trigger. */
export interface OwnedRun {
	backend: string;
	jobRef: string;
	buildNumber: string;
	queueId?: string;
}

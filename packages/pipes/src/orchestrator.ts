/**
 * Ports conty's app/service.go orchestrator: the one place every caller
 * routes through, so nothing talks to a CIBackend adapter directly.
 */
import { CHAIN_CRAWL_MAX_NODES } from "./constants.ts";
import type { BackendInfo } from "./run/backend.ts";
import {
	asArtifactStore,
	asChainable,
	asDiscoverable,
	asHistorical,
	asPipeliner,
	asRerunnable,
	asTriggerable,
	type CIBackend,
} from "./run/ci-backend.ts";
import {
	type BuildFilter,
	type CIArtifact,
	type CIArtifactDir,
	type CIRun,
	type CIRunNode,
	type CIRunRef,
	type CIStageNode,
	isTerminalStatus,
	type LogFilter,
	type LogResult,
	type RunStatus,
	type SearchResult,
} from "./run/ci-run.ts";
import { classifyLog } from "./run/classify.ts";
import type { RepoInfo, WorkflowInfo } from "./run/discovery.ts";
import type { CICheck, CIVerdict, FailureContext } from "./run/monitor.ts";
import type { Pipeline, PipelineRun, StepResult } from "./run/pipeline.ts";
import type { OwnedRun, TriggerReceipt, TriggerResult, WatchStatus } from "./run/trigger.ts";

export class BackendNotFoundError extends Error {
	constructor(name: string) {
		super(`backend not found: ${name}`);
	}
}

export class PipelineNotFoundError extends Error {
	constructor(name: string) {
		super(`pipeline not found: ${name}`);
	}
}

/** A trigger-time override attempted to set a key one of the pipeline's own steps locks. */
export class LockedParamOverrideError extends Error {
	constructor(pipeline: string, violations: Array<{ jobName: string; key: string }>) {
		const detail = violations.map((violation) => `${violation.key} (step "${violation.jobName}")`).join(", ");
		super(`pipeline "${pipeline}": override params cannot set locked key(s): ${detail}`);
	}
}

export class BackendUnavailableError extends Error {
	constructor(operation: string, backend: string, pipeline?: string) {
		const identity = pipeline ? `pipeline "${pipeline}" (backend "${backend}")` : `backend "${backend}"`;
		super(`backend unavailable during ${operation} for ${identity}; retry after backend recovery`);
	}
}

function isBackendTransportError(error: unknown): boolean {
	if (error instanceof TypeError) return true;
	if (!(error instanceof Error)) return false;
	return /fetch failed|network|socket|ECONNRESET|ECONNREFUSED|connection refused|timed? ?out|AbortError/i.test(
		`${error.name} ${error.message}`,
	);
}

export class StepOutOfRangeError extends Error {
	constructor(step: number, stepCount: number) {
		super(`step index out of range: ${step} (pipeline has ${stepCount} steps)`);
	}
}

export class CapabilityUnsupportedError extends Error {
	constructor(backend: string, capability: string) {
		super(`backend "${backend}" does not support ${capability}`);
	}
}

export class NotOwnedError extends Error {
	constructor(jobRef: string, runId: string) {
		super(`cannot act on ${jobRef} #${runId}: not owned by this session`);
	}
}

const TRIGGER_RESOLVE_POLL_MS = 2_000;

/**
 * Shared by ciWatch and ciGetRunWithProgress so the two can never drift: elapsed time comes from
 * the backend's own durationMs once terminal (most backends report 0 while still running), or
 * from startedAt otherwise. progressPercent/overdue are 0/false whenever there's no real estimate
 * (estimatedMs <= 0) -- callers that need to distinguish "no estimate" from "a real 0%" (see
 * ciGetRunWithProgress) check estimatedMs themselves before trusting these.
 */
function computeRunProgress(
	status: RunStatus,
	startedAt: Date,
	durationMs: number | undefined,
	estimatedMs: number,
	now: () => number,
): { elapsedMs: number; progressPercent: number; overdue: boolean } {
	const elapsedMs = isTerminalStatus(status) ? (durationMs ?? 0) : Math.max(0, now() - startedAt.getTime());
	if (estimatedMs <= 0) return { elapsedMs, progressPercent: 0, overdue: false };
	return { elapsedMs, progressPercent: (elapsedMs / estimatedMs) * 100, overdue: elapsedMs > estimatedMs * 1.5 };
}

export class Orchestrator {
	private readonly adapters = new Map<string, CIBackend>();
	private unconfigured: BackendInfo[] = [];
	private readonly pipelines = new Map<string, Pipeline>();
	private readonly runs = new Map<string, PipelineRun>();
	private readonly owned = new Map<string, OwnedRun>();

	addAdapter(backend: CIBackend): void {
		this.adapters.set(backend.name(), backend);
	}

	registerUnconfigured(infos: BackendInfo[]): void {
		this.unconfigured.push(...infos);
	}

	registerPipeline(pipeline: Pipeline): void {
		this.pipelines.set(pipeline.name, pipeline);
	}

	/** True when a preset by this name existed and was removed; false if it was never registered. */
	unregisterPipeline(name: string): boolean {
		return this.pipelines.delete(name);
	}

	getPipelineDefinition(name: string): Pipeline | undefined {
		return this.pipelines.get(name);
	}

	/** Every registered preset's full definition, not just names -- for a management UI to list/edit from. */
	listPipelineDefinitions(): Pipeline[] {
		return [...this.pipelines.values()];
	}

	private adapter(name: string): CIBackend {
		const backend = this.adapters.get(name);
		if (!backend) throw new BackendNotFoundError(name);
		return backend;
	}

	private pipeline(name: string): Pipeline {
		const pipeline = this.pipelines.get(name);
		if (!pipeline) throw new PipelineNotFoundError(name);
		return pipeline;
	}

	// ── Presets ──────────────────────────────────────────────────────────────

	/**
	 * Runs a named preset's steps sequentially against its backend, stopping at the first failure.
	 * `overrideParams`, when given, is merged on top of every step's own baked-in params (override
	 * wins on key collision) -- the per-invocation escape hatch for a preset whose parameters
	 * legitimately change between runs (a release version, a branch name), letting one value
	 * update in place instead of re-bookmarking the whole preset.
	 *
	 * A step's own `lockedParams` are exempt from that override: attempting to override a locked
	 * key rejects the whole trigger with LockedParamOverrideError before any step runs, rather than
	 * silently keeping the locked value -- a rejected trigger keeps a caller's own belief about
	 * what happened accurate, for a class of param (e.g. a bare-metal IPI job's network-management
	 * mode) where an accidental override has real physical consequences.
	 */
	async triggerPipeline(name: string, overrideParams: Record<string, string> = {}): Promise<PipelineRun> {
		const pipeline = this.pipeline(name);
		const backend = this.adapter(pipeline.backend);

		// Validated up front, so a locked-param violation fails the whole pipeline atomically,
		// before any step gets a chance to run.
		const violations = pipeline.steps.flatMap((step) =>
			Object.keys(step.lockedParams ?? {})
				.filter((key) => key in overrideParams)
				.map((key) => ({ jobName: step.jobName, key })),
		);
		if (violations.length > 0) throw new LockedParamOverrideError(name, violations);

		const run: PipelineRun = {
			pipeline: name,
			status: "running",
			steps: pipeline.steps.map((step) => ({ jobName: step.jobName, status: "running" as const, startedAt: new Date() })),
			startedAt: new Date(),
		};

		for (let i = 0; i < pipeline.steps.length; i++) {
			const step = pipeline.steps[i] as (typeof pipeline.steps)[number];
			const stepResult = run.steps[i] as StepResult;

			const triggerable = asTriggerable(backend);
			if (!triggerable) {
				stepResult.status = "failure";
				run.status = "failure";
				this.runs.set(name, run);
				return run;
			}

			let receipt: TriggerReceipt;
			try {
				receipt = await triggerable.trigger(step.jobName, { ...step.params, ...overrideParams, ...step.lockedParams });
				while (receipt.needsResolve) {
					await sleep(TRIGGER_RESOLVE_POLL_MS);
					receipt = await triggerable.resolveReceipt(receipt);
				}
			} catch {
				stepResult.status = "failure";
				run.status = "failure";
				this.runs.set(name, run);
				return run;
			}
			stepResult.runId = receipt.runId;

			let ciRun: CIRun;
			try {
				ciRun = await backend.getRun(step.jobName, receipt.runId ?? "");
			} catch {
				stepResult.status = "failure";
				run.status = "failure";
				this.runs.set(name, run);
				return run;
			}

			stepResult.status = ciRun.status;
			stepResult.result = ciRun.result;
			stepResult.durationMs = ciRun.durationMs;
			stepResult.url = ciRun.url;

			if (ciRun.status !== "success") {
				run.status = "failure";
				this.runs.set(name, run);
				return run;
			}
		}

		run.status = "success";
		run.durationMs = Date.now() - run.startedAt.getTime();
		this.runs.set(name, run);
		return run;
	}

	/**
	 * Returns the last run started by this process, or reconstructs the configured
	 * preset's current status from each step's backend "latest" view after a daemon
	 * restart. Preset identity is checked first: an empty in-memory run map must
	 * never make a still-configured pipeline look unknown.
	 */
	async getPipelineStatus(name: string): Promise<PipelineRun> {
		const pipeline = this.pipeline(name);
		const existing = this.runs.get(name);
		if (existing) return existing;

		const backend = this.adapter(pipeline.backend);
		let ciRuns: CIRun[];
		try {
			ciRuns = await Promise.all(pipeline.steps.map((step) => backend.getRun(step.jobName, "latest")));
		} catch (error) {
			if (isBackendTransportError(error)) throw new BackendUnavailableError("ci.status", pipeline.backend, name);
			throw error;
		}
		const startedAt = ciRuns.reduce(
			(earliest, run) => (run.startedAt.getTime() < earliest.getTime() ? run.startedAt : earliest),
			ciRuns[0]?.startedAt ?? new Date(),
		);
		const statuses = ciRuns.map((run) => run.status);
		const status = statuses.some((value) => value === "failure")
			? "failure"
			: statuses.some((value) => value === "aborted")
				? "aborted"
				: statuses.some((value) => value === "running")
					? "running"
					: statuses.some((value) => value === "pending")
						? "pending"
						: statuses.some((value) => value === "not_found")
							? "not_found"
							: "success";
		const recovered: PipelineRun = {
			pipeline: name,
			status,
			startedAt,
			steps: pipeline.steps.map((step, index) => {
				const run = ciRuns[index]!;
				return {
					jobName: step.jobName,
					runId: run.id,
					status: run.status,
					result: run.result,
					startedAt: run.startedAt,
					durationMs: run.durationMs,
					url: run.url,
				};
			}),
		};
		this.runs.set(name, recovered);
		return recovered;
	}

	async getStepLog(name: string, step: number, filter: LogFilter): Promise<LogResult> {
		const pipeline = this.pipeline(name);
		const run = this.runs.get(name);
		if (!run) throw new PipelineNotFoundError(name);
		if (step < 0 || step >= run.steps.length) throw new StepOutOfRangeError(step, run.steps.length);

		const backend = this.adapter(pipeline.backend);
		const stepResult = run.steps[step] as StepResult;
		const raw = await backend.getLog(stepResult.jobName, stepResult.runId ?? "", filter);
		return applyLogFilter(raw, filter);
	}

	listBackends(): string[] {
		return [...this.adapters.keys()];
	}

	listPipelines(): string[] {
		return [...this.pipelines.keys()];
	}

	/** The backend a named preset runs against — lets a caller attribute triggerPipeline's per-step results without re-deriving the pipeline's own config. */
	pipelineBackendName(name: string): string {
		return this.pipeline(name).backend;
	}

	backendInfo(): BackendInfo[] {
		const configured = [...this.adapters.values()].map((backend) => ({
			name: backend.name(),
			type: backend.type(),
			capabilities: describeBackendCapabilities(backend),
		}));
		const unconfigured = this.unconfigured.map((info) => ({ ...info, capabilities: "unconfigured" }));
		return [...configured, ...unconfigured];
	}

	// ── Real-time status: the compact, one-call answer ──────────────────────

	async checkLatest(backendName: string, jobRef: string): Promise<CICheck> {
		const backend = this.adapter(backendName);
		const run = await backend.getRun(jobRef, "latest");
		return { jobRef, backend: backendName, runId: run.id, status: run.status, checkedAt: new Date(), url: run.url };
	}

	async getVerdict(backendName: string, jobRef: string, runId: string | undefined, filter: LogFilter): Promise<CIVerdict> {
		const check =
			runId === undefined || runId === ""
				? await this.checkLatest(backendName, jobRef)
				: await (async (): Promise<CICheck> => {
						const backend = this.adapter(backendName);
						const run = await backend.getRun(jobRef, runId);
						return { jobRef, backend: backendName, runId: run.id, status: run.status, checkedAt: new Date(), url: run.url };
					})();

		if (check.status === "success") {
			return { check, testSummary: { total: 0, passed: 0, failed: 0, skipped: 0 } };
		}
		if (check.status === "failure") {
			const backend = this.adapter(backendName);
			const failure = await this.classifyFailure(backend, jobRef, check.runId, filter);
			return { check, failure };
		}
		return { check };
	}

	private async classifyFailure(backend: CIBackend, jobRef: string, runId: string, filter: LogFilter): Promise<FailureContext> {
		const failure: FailureContext = { classification: "unknown", canRetry: false };

		const pipeliner = asPipeliner(backend);
		if (pipeliner) {
			const stages = await pipeliner.listStages(jobRef, runId);
			const failed = stages.find((stage) => stage.status === "failure");
			if (failed) failure.failedJob = failed.name;
		}

		try {
			const raw = await backend.getLog(jobRef, runId, filter);
			if (raw.length > 0) {
				failure.log = applyLogFilter(raw, filter);
				const classified = classifyLog(failure.log.lines.join("\n"));
				failure.classification = classified.classification;
				failure.canRetry = classified.canRetry;
			}
		} catch {
			// Log fetch failure downgrades to "unknown" rather than failing the whole verdict.
		}

		return failure;
	}

	/**
	 * Real-time progress: percent complete against EstimateDuration, overdue past 1.5x estimate.
	 * A backend's own durationMs (e.g. Jenkins' `build.duration`) is only meaningful once a run is
	 * terminal -- most backends report it as 0 the entire time a run is still in progress, which
	 * would pin progressPercent at 0% for a run's whole duration. While still running/pending, derive
	 * elapsed time from startedAt instead, the one field every adapter populates from the run's real
	 * start time regardless of backend.
	 */
	async ciWatch(backendName: string, jobRef: string, runId: string, now: () => number = Date.now): Promise<WatchStatus> {
		const backend = this.adapter(backendName);
		const run = await backend.getRun(jobRef, runId);
		const estimatedMs = await this.estimateDurationFor(backend, jobRef);
		const { elapsedMs, progressPercent, overdue } = computeRunProgress(run.status, run.startedAt, run.durationMs, estimatedMs, now);

		return {
			buildNumber: run.id,
			jobRef,
			backend: backendName,
			status: run.status,
			progressPercent,
			elapsedMs,
			estimatedMs,
			overdue,
			url: run.url,
		};
	}

	private async estimateDurationFor(backend: CIBackend, jobRef: string): Promise<number> {
		const triggerable = asTriggerable(backend);
		return triggerable ? triggerable.estimateDuration(jobRef) : 0;
	}

	/**
	 * The pool-sync path's counterpart to ciWatch: a plain `getRun`, decorated with the same
	 * elapsed/estimated progress fields when a real estimate exists, so the background sync loop
	 * (see process/pool-sync.ts) can persist progress per subscribed job without a second, redundant
	 * ci.wait-shaped call per row. Unlike WatchStatus's always-present 0/false defaults, the three
	 * progress fields here are omitted entirely (not a misleading 0%/false) when there's no real
	 * estimate to compute from -- e.g. GitLab's own estimateDuration() unconditionally returning 0,
	 * or a backend with no CITriggerable capability at all.
	 */
	async ciGetRunWithProgress(
		backendName: string,
		jobRef: string,
		runId: string,
		now: () => number = Date.now,
	): Promise<CIRun & { progressPercent?: number; estimatedMs?: number; overdue?: boolean }> {
		const backend = this.adapter(backendName);
		const run = await backend.getRun(jobRef, runId);
		const estimatedMs = await this.estimateDurationFor(backend, jobRef);
		if (estimatedMs <= 0) return run;

		const { progressPercent, overdue } = computeRunProgress(run.status, run.startedAt, run.durationMs, estimatedMs, now);
		return { ...run, progressPercent, estimatedMs, overdue };
	}

	// ── Trigger / cancel with session ownership ─────────────────────────────

	async ciTrigger(backendName: string, jobRef: string, params: Record<string, string>): Promise<TriggerResult> {
		const backend = this.adapter(backendName);
		const triggerable = asTriggerable(backend);
		if (!triggerable) throw new CapabilityUnsupportedError(backendName, "triggering");

		let receipt = await triggerable.trigger(jobRef, params);
		if (receipt.needsResolve) {
			receipt = await triggerable.resolveReceipt(receipt);
		}

		const result: TriggerResult = { opaqueRef: receipt.opaqueRef, queueId: receipt.opaqueRef, jobRef, backend: backendName };
		if (receipt.runId) {
			result.buildNumber = receipt.runId;
			this.recordOwnership(backendName, jobRef, receipt.runId, receipt.opaqueRef);
			try {
				result.url = (await backend.getRun(jobRef, receipt.runId)).url;
			} catch {
				// A run that was just triggered may not be queryable yet on some backends -- the caller
				// still has buildNumber and can fetch the URL later via status/pool.
			}
		}

		const estimatedMs = await triggerable.estimateDuration(jobRef);
		if (estimatedMs > 0) {
			result.estimatedDurationMs = estimatedMs;
			result.pollIntervalMs = Math.max(estimatedMs / 20, 60_000);
		}
		return result;
	}

	async triggerRedeploy(backendName: string, jobRef: string): Promise<string> {
		return this.triggerRedeployWithParams(backendName, jobRef);
	}

	async triggerRedeployWithParams(backendName: string, jobRef: string, params?: Record<string, string>): Promise<string> {
		const backend = this.adapter(backendName);
		const triggerable = asTriggerable(backend);
		if (!triggerable) throw new CapabilityUnsupportedError(backendName, "triggering");

		let receipt = await triggerable.trigger(jobRef, params ?? {});
		if (receipt.needsResolve) {
			receipt = await triggerable.resolveReceipt(receipt);
		}
		const id = receipt.runId || receipt.opaqueRef || "";
		this.recordOwnership(backendName, jobRef, id, receipt.opaqueRef);
		return id;
	}

	/** Resolves a bare opaque trigger reference to a run ID without blocking on a full watch loop. */
	async ciPoll(backendName: string, jobRef: string, opaqueRef: string): Promise<string> {
		const backend = this.adapter(backendName);
		const triggerable = asTriggerable(backend);
		if (!triggerable) throw new CapabilityUnsupportedError(backendName, "trigger resolution");
		const resolved = await triggerable.resolveReceipt({ opaqueRef, needsResolve: true, backend: backendName, jobRef });
		return resolved.runId ?? "";
	}

	async ciRerun(backendName: string, jobRef: string, runId: string, failedOnly: boolean): Promise<void> {
		const backend = this.adapter(backendName);
		const rerunnable = asRerunnable(backend);
		if (!rerunnable) throw new CapabilityUnsupportedError(backendName, "rerun");
		await rerunnable.rerun(jobRef, runId, failedOnly);
	}

	async ciCancel(backendName: string, jobRef: string, runId: string): Promise<void> {
		if (!this.ownsRun(backendName, runId)) throw new NotOwnedError(jobRef, runId);
		const backend = this.adapter(backendName);
		await backend.cancelRun(jobRef, runId);
	}

	private recordOwnership(backendName: string, jobRef: string, buildNumber: string, queueId?: string): void {
		this.owned.set(`${backendName}:${buildNumber}`, { backend: backendName, jobRef, buildNumber, queueId });
	}

	ownsRun(backendName: string, buildNumber: string): boolean {
		return this.owned.has(`${backendName}:${buildNumber}`);
	}

	listOwnedRuns(): OwnedRun[] {
		return [...this.owned.values()];
	}

	// ── Read-only queries ────────────────────────────────────────────────────

	async ciGetRun(backendName: string, jobRef: string, runId: string): Promise<CIRun> {
		return this.adapter(backendName).getRun(jobRef, runId);
	}

	/** Full raw log text, no filtering — every real adapter already ignores the filter argument and returns the complete log, but ciLog's 50KB/tail defaults are for a live one-off read, not for what the local log cache should retain. */
	async ciGetRawLog(backendName: string, jobRef: string, runId: string): Promise<string> {
		return this.adapter(backendName).getLog(jobRef, runId, {});
	}

	async ciHistory(backendName: string, jobRef: string, limit = 10): Promise<CIRun[]> {
		const backend = this.adapter(backendName);
		const historical = asHistorical(backend);
		if (!historical) throw new CapabilityUnsupportedError(backendName, "run history");
		return historical.listRuns(jobRef, limit);
	}

	async ciSearch(backendName: string, jobRef: string, filter: BuildFilter): Promise<SearchResult> {
		return this.adapter(backendName).searchRuns(jobRef, filter);
	}

	async ciLog(backendName: string, jobRef: string, runId: string, filter: LogFilter): Promise<LogResult> {
		const backend = this.adapter(backendName);
		const resolvedRunId = runId || (await this.checkLatest(backendName, jobRef)).runId;
		const raw = await backend.getLog(jobRef, resolvedRunId, filter);
		return applyLogFilter(raw, filter);
	}

	async ciParams(backendName: string, jobRef: string, runId: string): Promise<Record<string, string>> {
		const backend = this.adapter(backendName);
		const historical = asHistorical(backend);
		if (!historical) throw new CapabilityUnsupportedError(backendName, "run params");
		return historical.getRunParams(jobRef, runId);
	}

	/** Caps each parameter value at 500 chars so an embedded YAML/JSON blob can't flood agent context. */
	async ciParamsTruncated(
		backendName: string,
		jobRef: string,
		runId: string,
	): Promise<{ params: Record<string, string>; truncatedKeys: string[] }> {
		const params = await this.ciParams(backendName, jobRef, runId);
		const MAX_VALUE_LENGTH = 500;
		const truncatedKeys: string[] = [];
		for (const [key, value] of Object.entries(params)) {
			if (value.length > MAX_VALUE_LENGTH) {
				params[key] = `${value.slice(0, MAX_VALUE_LENGTH)}...`;
				truncatedKeys.push(key);
			}
		}
		return { params, truncatedKeys };
	}

	async ciStageTree(backendName: string, jobRef: string, runId: string): Promise<CIStageNode[]> {
		const backend = this.adapter(backendName);
		const pipeliner = asPipeliner(backend);
		if (!pipeliner) throw new CapabilityUnsupportedError(backendName, "pipeline stages");
		return pipeliner.listStageNodes(jobRef, runId);
	}

	async ciStageTreeWithLogs(backendName: string, jobRef: string, runId: string): Promise<CIStageNode[]> {
		const backend = this.adapter(backendName);
		const pipeliner = asPipeliner(backend);
		if (!pipeliner) throw new CapabilityUnsupportedError(backendName, "pipeline stages");
		return pipeliner.listStageNodesWithLogs(jobRef, runId);
	}

	async ciArtifacts(backendName: string, jobRef: string, runId: string): Promise<CIArtifact[]> {
		const backend = this.adapter(backendName);
		const store = asArtifactStore(backend);
		if (!store) throw new CapabilityUnsupportedError(backendName, "artifacts");
		return store.listArtifacts(jobRef, runId);
	}

	async ciArtifactGet(backendName: string, jobRef: string, runId: string, path: string, maxBytes: number): Promise<Uint8Array> {
		const backend = this.adapter(backendName);
		const store = asArtifactStore(backend);
		if (!store) throw new CapabilityUnsupportedError(backendName, "artifact download");
		return store.getArtifact(jobRef, runId, path, maxBytes);
	}

	/** Applies LogFilter to a text artifact; throws for binary content so callers fall back to ciArtifactGet. */
	async ciArtifactText(backendName: string, jobRef: string, runId: string, path: string, filter: LogFilter): Promise<LogResult> {
		const data = await this.ciArtifactGet(backendName, jobRef, runId, path, 128 * 1024);
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(data);
		} catch {
			throw new Error("artifact is binary; use ciArtifactGet to download the raw bytes");
		}
		return applyLogFilter(text, filter);
	}

	async ciArtifactTree(backendName: string, jobRef: string, runId: string): Promise<CIArtifactDir> {
		const backend = this.adapter(backendName);
		const store = asArtifactStore(backend);
		if (!store) throw new CapabilityUnsupportedError(backendName, "artifacts");
		return buildArtifactTree(await store.listArtifacts(jobRef, runId));
	}

	/**
	 * Fetches a build and recursively expands its children up to depth levels
	 * (-1 = unlimited). Bounded independent of the caller's depth: a seen set
	 * (composite backend:jobRef:runId key) blocks cycles, and a hard node
	 * ceiling (CHAIN_CRAWL_MAX_NODES) stops the walk regardless of how deep
	 * depth asks to go, mirroring web-spider's crawl.ts (seen set + maxPages).
	 */
	async ciChain(backendName: string, jobRef: string, runId: string, depth: number, includeArtifacts: boolean): Promise<CIRunNode> {
		const backend = this.adapter(backendName);
		return chainExpand(backend, jobRef, runId, undefined, depth, includeArtifacts, new Set(), { remaining: CHAIN_CRAWL_MAX_NODES });
	}

	async ciDownstream(backendName: string, downstreamJob: string, upstreamJob: string, upstreamRunId: string): Promise<CIRun[]> {
		const backend = this.adapter(backendName);
		const chainable = asChainable(backend);
		if (!chainable) throw new CapabilityUnsupportedError(backendName, "chain traversal");
		return chainable.getDownstreamRuns(downstreamJob, upstreamJob, upstreamRunId);
	}

	async ciListRepos(backendName: string): Promise<RepoInfo[]> {
		const backend = this.adapter(backendName);
		const discoverable = asDiscoverable(backend);
		if (!discoverable) throw new CapabilityUnsupportedError(backendName, "repo discovery");
		return discoverable.listRepos();
	}

	async ciListWorkflows(backendName: string, repo: string): Promise<WorkflowInfo[]> {
		const backend = this.adapter(backendName);
		const discoverable = asDiscoverable(backend);
		if (!discoverable) throw new CapabilityUnsupportedError(backendName, "workflow discovery");
		return discoverable.listWorkflows(repo);
	}
}

function describeBackendCapabilities(backend: CIBackend): string {
	const parts: string[] = [];
	if (asTriggerable(backend)) parts.push("trigger");
	if (asHistorical(backend)) parts.push("history");
	if (asPipeliner(backend)) parts.push("stages");
	if (asArtifactStore(backend)) parts.push("artifacts");
	if (asChainable(backend)) parts.push("chain");
	if (asDiscoverable(backend)) parts.push("discover");
	if (asRerunnable(backend)) parts.push("rerun");
	return parts.length > 0 ? parts.join(" ") : "none";
}

function chainNodeKey(backend: CIBackend, jobRef: string, runId: string): string {
	return `${backend.name()}:${jobRef}:${runId}`;
}

async function chainExpand(
	backend: CIBackend,
	jobRef: string,
	runId: string,
	displayName: string | undefined,
	depth: number,
	includeArtifacts: boolean,
	seen: Set<string>,
	budget: { remaining: number },
): Promise<CIRunNode> {
	seen.add(chainNodeKey(backend, jobRef, runId));
	budget.remaining--;

	const run = await backend.getRun(jobRef, runId);
	const node: CIRunNode = {
		jobRef,
		runId: run.id,
		name: run.name,
		displayName,
		status: run.status,
		result: run.result,
		url: run.url,
		durationMs: run.durationMs,
	};

	if (includeArtifacts) {
		const store = asArtifactStore(backend);
		if (store) node.artifacts = await store.listArtifacts(jobRef, runId);
	}

	if (depth === 0 || budget.remaining <= 0) return node;
	const nextDepth = depth < 0 ? -1 : depth - 1;

	const childRefs: CIRunRef[] = [...(run.children ?? [])];
	// Supplements (never replaces) run.children with a CIChainable backend's own downstream
	// lookup, so GitLab's real trigger_jobs data shows up in the tree even though GitLab's
	// getRun never populates children itself. Called with an empty downstreamJob: GitLab
	// ignores it entirely (bridges are scoped to the parent pipeline), but Jenkins' adapter
	// needs a real downstream job name to build its query path, so this generic call harmlessly
	// finds nothing for Jenkins -- full Jenkins downstream discovery requires the explicit
	// ci.downstream operation with a known job name, not this automatic tree crawl.
	const chainable = asChainable(backend);
	if (chainable) {
		try {
			const downstream = await chainable.getDownstreamRuns("", jobRef, run.id);
			for (const downstreamRun of downstream)
				childRefs.push({ jobRef: downstreamRun.name, runId: downstreamRun.id, displayName: downstreamRun.name });
		} catch {
			// Downstream lookup is best-effort supplementary data; a failed lookup must not fail the whole tree.
		}
	}
	if (childRefs.length === 0) return node;

	node.children = [];
	for (const ref of childRefs) {
		if (budget.remaining <= 0) break;
		const childKey = chainNodeKey(backend, ref.jobRef, ref.runId);
		if (seen.has(childKey)) continue;
		try {
			node.children.push(await chainExpand(backend, ref.jobRef, ref.runId, ref.displayName, nextDepth, includeArtifacts, seen, budget));
		} catch {
			node.children.push({ jobRef: ref.jobRef, runId: ref.runId, name: "", displayName: ref.displayName, status: "not_found" });
		}
	}
	return node;
}

/** Groups a flat artifact list into a directory tree using each artifact's `/`-separated path. */
function buildArtifactTree(artifacts: CIArtifact[]): CIArtifactDir {
	const root: CIArtifactDir = { path: "" };
	for (const artifact of artifacts) insertArtifact(root, artifact);
	return root;
}

function insertArtifact(dir: CIArtifactDir, artifact: CIArtifact): void {
	const slash = artifact.path.indexOf("/");
	if (slash < 0) {
		dir.files = [...(dir.files ?? []), artifact];
		return;
	}
	const segment = artifact.path.slice(0, slash);
	const child: CIArtifact = { ...artifact, path: artifact.path.slice(slash + 1) };
	dir.children ??= [];
	const existing = dir.children.find((c) => c.path === segment);
	if (existing) {
		insertArtifact(existing, child);
		return;
	}
	const created: CIArtifactDir = { path: segment };
	dir.children.push(created);
	insertArtifact(created, child);
}

/** Compiles grep as a case-insensitive regexp; falls back to a literal substring match on invalid regexp. */
function compileGrepPattern(pattern: string): (line: string) => boolean {
	try {
		const re = new RegExp(pattern, "i");
		return (line) => re.test(line);
	} catch {
		const lower = pattern.toLowerCase();
		return (line) => line.toLowerCase().includes(lower);
	}
}

/**
 * grep narrows lines first; when grep is set, the normal default tail is
 * skipped so all matches are returned (an explicit tail still caps them).
 * Tail is applied next, then a byte cap trims further from the front.
 */
export function applyLogFilter(raw: string, filter: LogFilter): LogResult {
	let lines = raw.split("\n");

	if (filter.grep) {
		const match = compileGrepPattern(filter.grep);
		lines = lines.filter(match);
	}

	const totalLines = lines.length;

	let tail = filter.tail ?? 0;
	if (tail === 0 && !filter.grep) tail = 200;

	let skipped = 0;
	let truncated = false;
	if (tail > 0 && lines.length > tail) {
		skipped = lines.length - tail;
		lines = lines.slice(skipped);
		truncated = true;
	}

	const MAX_BYTES = 50 * 1024;
	let byteTotal = lines.reduce((sum, line) => sum + line.length + 1, 0);
	while (byteTotal > MAX_BYTES && lines.length > 0) {
		byteTotal -= (lines[0]?.length ?? 0) + 1;
		skipped++;
		lines = lines.slice(1);
		truncated = true;
	}

	return { lines, totalLines, skipped, filtered: Boolean(filter.grep), truncated };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

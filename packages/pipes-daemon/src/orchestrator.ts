/**
 * Ports conty's app/service.go orchestrator: the one place every caller
 * routes through, so nothing talks to a CIBackend adapter directly.
 */
import { classifyLog } from "./classify.ts";
import type { BackendInfo } from "./domain/backend.ts";
import type {
	BuildFilter,
	CIArtifact,
	CIArtifactDir,
	CIRun,
	CIRunNode,
	CIStageNode,
	LogFilter,
	LogResult,
} from "./domain/ci-run.ts";
import type { CICheck, CIVerdict, FailureContext } from "./domain/monitor.ts";
import type { Pipeline, PipelineRun, StepResult } from "./domain/pipeline.ts";
import type { OwnedRun, TriggerReceipt, TriggerResult, WatchStatus } from "./domain/trigger.ts";
import {
	asArtifactStore,
	asChainable,
	asHistorical,
	asPipeliner,
	asTriggerable,
	type CIBackend,
} from "./ports/ci-backend.ts";

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

	/** Runs a named preset's steps sequentially against its backend, stopping at the first failure. */
	async triggerPipeline(name: string): Promise<PipelineRun> {
		const pipeline = this.pipeline(name);
		const backend = this.adapter(pipeline.backend);

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
				receipt = await triggerable.trigger(step.jobName, step.params ?? {});
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

	getPipelineStatus(name: string): PipelineRun {
		const run = this.runs.get(name);
		if (!run) throw new PipelineNotFoundError(name);
		return run;
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
		return { jobRef, backend: backendName, runId: run.id, status: run.status, checkedAt: new Date() };
	}

	async getVerdict(backendName: string, jobRef: string, runId: string | undefined, filter: LogFilter): Promise<CIVerdict> {
		const check =
			runId === undefined || runId === ""
				? await this.checkLatest(backendName, jobRef)
				: await (async (): Promise<CICheck> => {
						const backend = this.adapter(backendName);
						const run = await backend.getRun(jobRef, runId);
						return { jobRef, backend: backendName, runId: run.id, status: run.status, checkedAt: new Date() };
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

	/** Real-time progress: percent complete against EstimateDuration, overdue past 1.5x estimate. */
	async ciWatch(backendName: string, jobRef: string, runId: string): Promise<WatchStatus> {
		const backend = this.adapter(backendName);
		const run = await backend.getRun(jobRef, runId);

		const triggerable = asTriggerable(backend);
		const estimatedMs = triggerable ? await triggerable.estimateDuration(jobRef) : 0;
		const elapsedMs = run.durationMs ?? 0;

		const watch: WatchStatus = {
			buildNumber: run.id,
			jobRef,
			backend: backendName,
			status: run.status,
			progressPercent: 0,
			elapsedMs,
			estimatedMs,
			overdue: false,
		};
		if (estimatedMs > 0) {
			watch.progressPercent = (elapsedMs / estimatedMs) * 100;
			watch.overdue = elapsedMs > estimatedMs * 1.5;
		}
		return watch;
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

		const result: TriggerResult = { queueId: receipt.opaqueRef, jobRef, backend: backendName };
		if (receipt.runId) {
			result.buildNumber = receipt.runId;
			this.recordOwnership(backendName, jobRef, receipt.runId, receipt.opaqueRef);
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
	async ciPoll(backendName: string, opaqueRef: string): Promise<string> {
		const backend = this.adapter(backendName);
		const triggerable = asTriggerable(backend);
		if (!triggerable) throw new CapabilityUnsupportedError(backendName, "trigger resolution");
		const resolved = await triggerable.resolveReceipt({ opaqueRef, needsResolve: true, backend: backendName, jobRef: "" });
		return resolved.runId ?? "";
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

	async ciSearch(backendName: string, jobRef: string, filter: BuildFilter): Promise<CIRun[]> {
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
	async ciParamsTruncated(backendName: string, jobRef: string, runId: string): Promise<{ params: Record<string, string>; truncatedKeys: string[] }> {
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

	async ciArtifactGet(backendName: string, jobRef: string, runId: string, path: string): Promise<Uint8Array> {
		const backend = this.adapter(backendName);
		const store = asArtifactStore(backend);
		if (!store) throw new CapabilityUnsupportedError(backendName, "artifact download");
		return store.getArtifact(jobRef, runId, path);
	}

	/** Applies LogFilter to a text artifact; throws for binary content so callers fall back to ciArtifactGet. */
	async ciArtifactText(backendName: string, jobRef: string, runId: string, path: string, filter: LogFilter): Promise<LogResult> {
		const data = await this.ciArtifactGet(backendName, jobRef, runId, path);
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

	/** Fetches a build and recursively expands its children up to depth levels (-1 = unlimited). */
	async ciChain(backendName: string, jobRef: string, runId: string, depth: number, includeArtifacts: boolean): Promise<CIRunNode> {
		const backend = this.adapter(backendName);
		return chainExpand(backend, jobRef, runId, undefined, depth, includeArtifacts);
	}

	async ciDownstream(backendName: string, downstreamJob: string, upstreamJob: string, upstreamRunId: string): Promise<CIRun[]> {
		const backend = this.adapter(backendName);
		const chainable = asChainable(backend);
		if (!chainable) throw new CapabilityUnsupportedError(backendName, "chain traversal");
		return chainable.getDownstreamRuns(downstreamJob, upstreamJob, upstreamRunId);
	}
}

function describeBackendCapabilities(backend: CIBackend): string {
	const parts: string[] = [];
	if (asTriggerable(backend)) parts.push("trigger");
	if (asHistorical(backend)) parts.push("history");
	if (asPipeliner(backend)) parts.push("stages");
	if (asArtifactStore(backend)) parts.push("artifacts");
	if (asChainable(backend)) parts.push("chain");
	return parts.length > 0 ? parts.join(" ") : "none";
}

async function chainExpand(
	backend: CIBackend,
	jobRef: string,
	runId: string,
	displayName: string | undefined,
	depth: number,
	includeArtifacts: boolean,
): Promise<CIRunNode> {
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

	if (depth === 0 || !run.children || run.children.length === 0) return node;
	const nextDepth = depth < 0 ? -1 : depth - 1;

	node.children = [];
	for (const ref of run.children) {
		try {
			node.children.push(await chainExpand(backend, ref.jobRef, ref.runId, ref.displayName, nextDepth, includeArtifacts));
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

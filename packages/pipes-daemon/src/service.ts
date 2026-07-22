/** Operation registry + fetch handler: bearer auth, /health, /ready, /api/v1/ops. */
import { errorResponse, healthResponse, jsonResponse, readyResponse, requireBearerToken } from "@danypops/daemon-kit/http";
import type { CIRunNode, CIStageNode, LogResult, RunResult } from "./domain/ci-run.ts";
import type { PipelineRun } from "./domain/pipeline.ts";
import type { TriggerResult, WatchStatus } from "./domain/trigger.ts";
import {
	BackendNotFoundError,
	CapabilityUnsupportedError,
	NotOwnedError,
	Orchestrator,
	PipelineNotFoundError,
	StepOutOfRangeError,
} from "./orchestrator.ts";
import { isTerminalStatus, type RunPool, type RunSnapshot } from "./run-pool.ts";
import { VERSION } from "./version.ts";

const DEFAULT_WAIT_TIMEOUT_S = 3600;
const DEFAULT_WAIT_POLL_MS = 15_000;

export type OperationName =
	| "ci.help"
	| "ci.status"
	| "ci.log"
	| "ci.search"
	| "ci.trigger"
	| "ci.wait"
	| "ci.cancel"
	| "ci.stages"
	| "ci.chain"
	| "ci.pool";

export interface OperationInputs {
	"ci.help": Record<string, never>;
	"ci.status": { backend?: string; jobRef?: string; runId?: string; pipeline?: string; tail?: number; grep?: string; includeParams?: boolean };
	"ci.log": { backend?: string; jobRef?: string; runId?: string; pipeline?: string; step?: number; tail?: number; grep?: string };
	"ci.search": { backend: string; jobRef: string; result?: RunResult; runner?: string; since?: string; limit?: number; params?: Record<string, string> };
	"ci.trigger": { backend?: string; jobRef?: string; pipeline?: string; params?: Record<string, string> };
	"ci.wait": { backend: string; jobRef?: string; runId?: string; opaqueRef?: string; timeoutS?: number };
	"ci.cancel": { backend: string; jobRef: string; runId: string };
	"ci.stages": { backend: string; jobRef: string; runId: string; steps?: boolean; includeFailedLog?: boolean };
	"ci.chain": { backend: string; jobRef: string; runId: string; depth?: number; artifacts?: boolean };
	"ci.pool": { backend: string; jobRef: string; limit?: number };
}

export interface OperationOutputs {
	"ci.help": { backends: ReturnType<Orchestrator["backendInfo"]>; pipelines: string[] };
	"ci.status": { pipelineRun?: PipelineRun; verdict?: unknown; params?: Record<string, string>; truncatedParamKeys?: string[] };
	"ci.log": LogResult;
	"ci.search": { builds: unknown[] };
	"ci.trigger": { pipelineRun?: PipelineRun; result?: TriggerResult };
	"ci.wait": WatchStatus | { buildNumber: string };
	"ci.cancel": { status: "cancelled"; runId: string };
	"ci.stages": { stages: CIStageNode[] | Array<{ id: string; name: string; status: string; durationMs?: number }> };
	"ci.chain": CIRunNode;
	/** Reads only the local pool — never a live backend call, safe to call frequently. Empty when no pool is configured. */
	"ci.pool": { runs: RunSnapshot[] };
}

export class UnknownOperationError extends Error {
	constructor(op: string) {
		super(`unknown operation: ${op}`);
	}
}

export interface PipesService {
	operationNames(): OperationName[];
	execute<Name extends OperationName>(op: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]>;
}

const OPERATION_NAMES: OperationName[] = [
	"ci.help",
	"ci.status",
	"ci.log",
	"ci.search",
	"ci.trigger",
	"ci.wait",
	"ci.cancel",
	"ci.stages",
	"ci.chain",
	"ci.pool",
];

export interface CreatePipesServiceOptions {
	/** Overridable for tests; production default is 15s, matching conty's wait ticker. */
	waitPollIntervalMs?: number;
	/** Optional: when present, trigger seeds the local pool and ci.pool reads from it. Absent in tests that don't exercise pooling. */
	runPool?: RunPool;
}

export function createPipesService(orchestrator: Orchestrator, options: CreatePipesServiceOptions = {}): PipesService {
	const pollIntervalMs = options.waitPollIntervalMs ?? DEFAULT_WAIT_POLL_MS;
	const pool = options.runPool;

	async function handleStatus(input: OperationInputs["ci.status"]): Promise<OperationOutputs["ci.status"]> {
		if (input.pipeline) {
			return { pipelineRun: orchestrator.getPipelineStatus(input.pipeline) };
		}
		if (!input.backend || !input.jobRef) throw new Error("backend and jobRef are required when pipeline is not set");
		const verdict = await orchestrator.getVerdict(input.backend, input.jobRef, input.runId, { tail: input.tail, grep: input.grep });
		const out: OperationOutputs["ci.status"] = { verdict };
		if (input.includeParams && verdict.check.runId) {
			const { params, truncatedKeys } = await orchestrator.ciParamsTruncated(input.backend, input.jobRef, verdict.check.runId);
			out.params = params;
			if (truncatedKeys.length > 0) out.truncatedParamKeys = truncatedKeys;
		}
		return out;
	}

	async function handleLog(input: OperationInputs["ci.log"]): Promise<LogResult> {
		const filter = { tail: input.tail, grep: input.grep };
		if (input.pipeline) return orchestrator.getStepLog(input.pipeline, input.step ?? 0, filter);
		if (!input.backend || !input.jobRef) throw new Error("backend and jobRef are required when pipeline is not set");
		return orchestrator.ciLog(input.backend, input.jobRef, input.runId ?? "", filter);
	}

	async function handleTrigger(input: OperationInputs["ci.trigger"]): Promise<OperationOutputs["ci.trigger"]> {
		if (input.pipeline) {
			const pipelineRun = await orchestrator.triggerPipeline(input.pipeline);
			if (pool) seedPoolFromPipelineRun(pool, orchestrator.pipelineBackendName(input.pipeline), pipelineRun);
			return { pipelineRun };
		}
		if (!input.backend || !input.jobRef) throw new Error("backend and jobRef are required when pipeline is not set");
		const result = await orchestrator.ciTrigger(input.backend, input.jobRef, input.params ?? {});
		if (pool && result.buildNumber) seedPoolFromTrigger(pool, input.backend, input.jobRef, result.buildNumber);
		return { result };
	}

	/** Genuinely blocking: polls ciWatch on an interval until a terminal status or timeout, exactly like conty's wait action. */
	async function handleWait(input: OperationInputs["ci.wait"]): Promise<OperationOutputs["ci.wait"]> {
		if (input.opaqueRef) {
			return { buildNumber: await orchestrator.ciPoll(input.backend, input.opaqueRef) };
		}
		if (!input.runId || !input.jobRef) {
			throw new Error("wait requires opaqueRef (resolve) or jobRef+runId (watch)");
		}
		const deadline = Date.now() + (input.timeoutS ?? DEFAULT_WAIT_TIMEOUT_S) * 1000;
		for (;;) {
			const status = await orchestrator.ciWatch(input.backend, input.jobRef, input.runId);
			if (status.status !== "running" && status.status !== "pending") return status;
			if (Date.now() >= deadline) return status;
			await sleep(Math.min(pollIntervalMs, Math.max(deadline - Date.now(), 0)));
		}
	}

	async function handleStages(input: OperationInputs["ci.stages"]): Promise<OperationOutputs["ci.stages"]> {
		if (input.steps) {
			const nodes = input.includeFailedLog
				? await orchestrator.ciStageTreeWithLogs(input.backend, input.jobRef, input.runId)
				: await orchestrator.ciStageTree(input.backend, input.jobRef, input.runId);
			return { stages: nodes };
		}
		const nodes = await orchestrator.ciStageTree(input.backend, input.jobRef, input.runId);
		return { stages: nodes.map((node) => ({ id: node.id, name: node.name, status: node.status, durationMs: node.durationMs })) };
	}

	return {
		operationNames(): OperationName[] {
			return OPERATION_NAMES;
		},
		async execute<Name extends OperationName>(op: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]> {
			switch (op) {
				case "ci.pool": {
					const pooled = input as OperationInputs["ci.pool"];
					return { runs: pool ? pool.recent(pooled.backend, pooled.jobRef, pooled.limit ?? 20) : [] } as OperationOutputs[Name];
				}
				case "ci.help":
					return { backends: orchestrator.backendInfo(), pipelines: orchestrator.listPipelines() } as OperationOutputs[Name];
				case "ci.status":
					return (await handleStatus(input as OperationInputs["ci.status"])) as OperationOutputs[Name];
				case "ci.log":
					return (await handleLog(input as OperationInputs["ci.log"])) as OperationOutputs[Name];
				case "ci.search": {
					const search = input as OperationInputs["ci.search"];
					const builds = await orchestrator.ciSearch(search.backend, search.jobRef, {
						result: search.result,
						runner: search.runner,
						since: search.since ? new Date(search.since) : undefined,
						limit: search.limit,
						params: search.params,
					});
					return { builds } as OperationOutputs[Name];
				}
				case "ci.trigger":
					return (await handleTrigger(input as OperationInputs["ci.trigger"])) as OperationOutputs[Name];
				case "ci.wait":
					return (await handleWait(input as OperationInputs["ci.wait"])) as OperationOutputs[Name];
				case "ci.cancel": {
					const cancel = input as OperationInputs["ci.cancel"];
					await orchestrator.ciCancel(cancel.backend, cancel.jobRef, cancel.runId);
					return { status: "cancelled", runId: cancel.runId } as OperationOutputs[Name];
				}
				case "ci.stages":
					return (await handleStages(input as OperationInputs["ci.stages"])) as OperationOutputs[Name];
				case "ci.chain": {
					const chain = input as OperationInputs["ci.chain"];
					return (await orchestrator.ciChain(chain.backend, chain.jobRef, chain.runId, chain.depth ?? 3, chain.artifacts ?? false)) as OperationOutputs[Name];
				}
				default:
					throw new UnknownOperationError(op);
			}
		},
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Seeds one row per resolved step so the background sync loop picks them up on its next tick, without waiting for a caller to ask ci.status first. */
function seedPoolFromPipelineRun(pool: RunPool, backend: string, pipelineRun: PipelineRun): void {
	const fetchedAt = new Date();
	for (const step of pipelineRun.steps) {
		if (!step.runId) continue;
		pool.upsert({
			backend,
			jobRef: step.jobName,
			runId: step.runId,
			status: step.status,
			result: step.result ?? "",
			url: step.url ?? "",
			startedAt: step.startedAt ?? fetchedAt,
			durationMs: step.durationMs,
			fetchedAt,
			watched: !isTerminalStatus(step.status),
		});
	}
}

/** Seeds an approximate "pending" row immediately after trigger — the background sync loop corrects it to the real status on its first tick. */
function seedPoolFromTrigger(pool: RunPool, backend: string, jobRef: string, runId: string): void {
	const now = new Date();
	pool.upsert({ backend, jobRef, runId, status: "pending", result: "", url: "", startedAt: now, fetchedAt: now, watched: true });
}

async function readOperationBody(request: Request): Promise<{ op?: unknown; input?: unknown }> {
	return (await request.json()) as { op?: unknown; input?: unknown };
}

function statusForError(error: unknown): number {
	if (error instanceof BackendNotFoundError || error instanceof PipelineNotFoundError) return 404;
	if (error instanceof UnknownOperationError) return 404;
	if (error instanceof NotOwnedError) return 403;
	if (error instanceof CapabilityUnsupportedError || error instanceof StepOutOfRangeError) return 400;
	return 400;
}

export function createApp(deps: { service: PipesService; token: string }): { fetch(request: Request): Promise<Response> } {
	return {
		async fetch(request: Request): Promise<Response> {
			if (!requireBearerToken(request, deps.token)) {
				return errorResponse("missing or invalid bearer token", 401);
			}
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/health") {
				return healthResponse(VERSION);
			}
			if (request.method === "GET" && url.pathname === "/ready") {
				return readyResponse(true);
			}
			if (request.method === "GET" && url.pathname === "/api/v1/ops") {
				return jsonResponse({ operations: deps.service.operationNames() });
			}
			if (request.method === "POST" && url.pathname === "/api/v1/ops") {
				try {
					const body = await readOperationBody(request);
					if (typeof body.op !== "string") return errorResponse("op is required", 400);
					const input = body.input === undefined ? {} : body.input;
					if (typeof input !== "object" || input === null || Array.isArray(input)) {
						return errorResponse("input must be an object", 400);
					}
					const result = await deps.service.execute(body.op as OperationName, input as OperationInputs[OperationName]);
					return jsonResponse({ result });
				} catch (error) {
					return errorResponse(error instanceof Error ? error.message : String(error), statusForError(error));
				}
			}
			return errorResponse("not found", 404);
		},
	};
}

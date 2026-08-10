/**
 * Operation registry + fetch handler: bearer auth, /health, /ready,
 * /api/v1/ops, and a VehicleRegistry (see ../vehicle/pipes-vehicle.ts)
 * mounted at /vehicle/* -- same daemon, same auth, same port, not a second
 * service to stand up. Every operation here has a CLI command
 * (cli/index.ts) and a pi-pipes Vehicle-projected tool -- no operation
 * exists only for one caller.
 */
import type { VehicleRegistry } from "@danypops/vehicle-server";
import { createVehicleHttpApp } from "@danypops/vehicle-server/http";
import { errorResponse, healthResponse, jsonResponse, readyResponse, requireBearerToken } from "@danypops/vehicle-server/rpc-http";
import { defaultPresetsPath, savePresets } from "../config/presets.ts";
import { DEFAULT_LOG_TAIL_TOKENS } from "../constants.ts";
import type { Orchestrator } from "../orchestrator.ts";
import type {
	Dashboard,
	DashboardCreateInput,
	DefectUpdate,
	Launch,
	LaunchFilter,
	TestItem,
	TestItemFilter,
	Widget,
	WidgetAddInput,
} from "../reportportal/launch.ts";
import type { LaunchBackend } from "../reportportal/launch-backend.ts";
import type { CIRunNode, CIStageNode, LogResult, RunResult } from "../run/ci-run.ts";
import type { RepoInfo, WorkflowInfo } from "../run/discovery.ts";
import type { Pipeline, PipelineRun } from "../run/pipeline.ts";
import type { TriggerResult, WatchStatus } from "../run/trigger.ts";
import { isTerminalStatus, type RunPool, type RunSnapshot } from "../sqlite/run-pool.ts";
import { tailByTokenBudget } from "../truncate.ts";
import { createPipesVehicleRegistry } from "../vehicle/pipes-vehicle.ts";
import { VERSION } from "../version.ts";
import { statusForKnownPipesError } from "./error-status.ts";

const DEFAULT_WAIT_TIMEOUT_S = 3600;
const DEFAULT_WAIT_POLL_MS = 15_000;

export type OperationName =
	| "ci.help"
	| "ci.status"
	| "ci.log"
	| "ci.search"
	| "ci.discover"
	| "ci.trigger"
	| "ci.wait"
	| "ci.cancel"
	| "ci.stages"
	| "ci.chain"
	| "ci.pool"
	| "ci.subscribed"
	| "ci.subscribe"
	| "ci.unsubscribe"
	| "ci.tail"
	| "ci.downstream"
	| "ci.presets.list"
	| "ci.presets.set"
	| "ci.presets.remove"
	| "rp.launches"
	| "rp.launch"
	| "rp.items"
	| "rp.search"
	| "rp.item"
	| "rp.items.get"
	| "rp.defects.update"
	| "rp.dashboards"
	| "rp.dashboard"
	| "rp.dashboard.create"
	| "rp.dashboard.widget.add";

export interface OperationInputs {
	"ci.help": Record<string, never>;
	"ci.status": {
		backend?: string;
		jobRef?: string;
		runId?: string;
		pipeline?: string;
		tail?: number;
		grep?: string;
		includeParams?: boolean;
	};
	"ci.log": { backend?: string; jobRef?: string; runId?: string; pipeline?: string; step?: number; tail?: number; grep?: string };
	"ci.search": {
		backend: string;
		jobRef: string;
		result?: RunResult;
		runner?: string;
		since?: string;
		limit?: number;
		params?: Record<string, string>;
	};
	/** repo given lists workflows in it; omitted lists every repo the backend's credential can see under its owner. */
	"ci.discover": { backend: string; repo?: string };
	"ci.trigger": { backend?: string; jobRef?: string; pipeline?: string; params?: Record<string, string> };
	"ci.wait": { backend: string; jobRef?: string; runId?: string; opaqueRef?: string; timeoutS?: number };
	"ci.cancel": { backend: string; jobRef: string; runId: string };
	"ci.stages": { backend: string; jobRef: string; runId: string; steps?: boolean; includeFailedLog?: boolean };
	"ci.chain": { backend: string; jobRef: string; runId: string; depth?: number; artifacts?: boolean };
	"ci.pool": { backend: string; jobRef: string; limit?: number };
	/** Every currently-subscribed job across every backend/jobRef -- unlike ci.pool (one job's own recent
	 * history), this is the "what's subscribed right now" listing a jobs-overview widget polls. */
	"ci.subscribed": Record<string, never>;
	/** subscriberId defaults to "" -- the same anonymous subscriber every pre-existing caller implicitly uses. scheduleMs, when set, is this subscriber's own minimum check cadence; omitted checks on every background sync tick. runId, when set, pins this watch to that exact run forever instead of always re-resolving "latest" -- use this whenever you already have a concrete run id, especially on a job with other unrelated concurrent triggers. */
	"ci.subscribe": { backend: string; jobRef: string; subscriberId?: string; scheduleMs?: number; runId?: string };
	/** subscriberId defaults to "", removing only that one subscription -- another subscriber's independent watch on the same job is untouched. */
	"ci.unsubscribe": { backend: string; jobRef: string; subscriberId?: string };
	"ci.tail": { backend: string; jobRef: string; runId?: string; maxTokens?: number };
	/** Targeted lookup for backends (Jenkins) where ci.chain's automatic tree crawl can't discover children without already knowing the downstream job name. */
	"ci.downstream": { backend: string; downstreamJob: string; upstreamJob: string; upstreamRunId: string };
	"ci.presets.list": Record<string, never>;
	/** Upsert by name -- setting an existing name's preset replaces it entirely, matching Orchestrator.registerPipeline's Map semantics. */
	"ci.presets.set": { preset: Pipeline };
	"ci.presets.remove": { name: string };
	/** Date-range fields travel as ISO strings over RPC, converted to Date at the handler boundary -- same pattern ci.search already uses for `since`. */
	"rp.launches": Omit<LaunchFilter, "startAfter" | "startBefore"> & { startAfter?: string; startBefore?: string };
	"rp.launch": { id: string };
	"rp.items": { launchId: string; filter?: RpTestItemFilterInput };
	"rp.search": RpTestItemFilterInput;
	"rp.item": { id: string };
	"rp.items.get": { ids: string[] };
	"rp.defects.update": { updates: DefectUpdate[] };
	"rp.dashboards": Record<string, never>;
	"rp.dashboard": { id: string };
	"rp.dashboard.create": DashboardCreateInput;
	"rp.dashboard.widget.add": { dashboardId: string } & WidgetAddInput;
}

/** TestItemFilter's date-range fields (since/before) as ISO strings over RPC, matching LaunchFilter's own rp.launches convention above. */
export type RpTestItemFilterInput = Omit<TestItemFilter, "since" | "before"> & { since?: string; before?: string };

export interface OperationOutputs {
	"ci.help": { backends: ReturnType<Orchestrator["backendInfo"]>; pipelines: string[] };
	"ci.status": { pipelineRun?: PipelineRun; verdict?: unknown; params?: Record<string, string>; truncatedParamKeys?: string[] };
	"ci.log": LogResult;
	/** truncated mirrors SearchResult.truncated -- true when the backend gave up at a page-cap safety valve before `since`/`limit` was conclusively satisfied. See run/ci-run.ts's SearchResult doc comment. */
	"ci.search": { builds: unknown[]; truncated: boolean };
	/** Exactly one of repos/workflows is present, matching which input.repo case was requested. */
	"ci.discover": { repos?: RepoInfo[]; workflows?: WorkflowInfo[] };
	"ci.trigger": { pipelineRun?: PipelineRun; result?: TriggerResult };
	"ci.wait": WatchStatus | { buildNumber: string };
	"ci.cancel": { status: "cancelled"; runId: string };
	"ci.stages": { stages: CIStageNode[] | Array<{ id: string; name: string; status: string; durationMs?: number }> };
	"ci.chain": CIRunNode;
	/** Reads only the local pool — never a live backend call, safe to call frequently. Empty when no pool is configured. */
	"ci.pool": { runs: RunSnapshot[] };
	/** Every currently-watched run (RunPool.watchedRuns()) -- never a live backend call, safe to poll
	 * frequently. Empty when no pool is configured. */
	"ci.subscribed": { runs: RunSnapshot[] };
	/** Idempotent: seeds an immediate fetch and starts background refreshing that job's latest run. */
	"ci.subscribe": { subscribed: true; run?: RunSnapshot };
	/** Idempotent: no error if the job wasn't subscribed. */
	"ci.unsubscribe": { unsubscribed: true };
	"ci.tail": { runId: string; status: string; text: string; truncated: boolean; totalTokens: number; outputTokens: number; url?: string };
	"ci.downstream": { runs: unknown[] };
	"ci.presets.list": { presets: Pipeline[] };
	"ci.presets.set": { preset: Pipeline };
	/** True when a preset by this name existed and was removed; false if it was never registered -- idempotent, not an error either way. */
	"ci.presets.remove": { removed: boolean };
	"rp.launches": { launches: Launch[] };
	"rp.launch": { launch: Launch };
	"rp.items": { items: TestItem[] };
	"rp.search": { items: TestItem[] };
	"rp.item": { item: TestItem };
	"rp.items.get": { items: TestItem[] };
	"rp.defects.update": { updated: number };
	"rp.dashboards": { dashboards: Dashboard[] };
	"rp.dashboard": { dashboard: Dashboard };
	"rp.dashboard.create": { dashboard: Dashboard };
	"rp.dashboard.widget.add": { widget: Widget };
}

export class UnknownOperationError extends Error {
	constructor(op: string) {
		super(`unknown operation: ${op}`);
	}
}

export class ReportPortalNotConfiguredError extends Error {
	constructor() {
		super("Report Portal is not configured -- set RP_URL/RP_PROJECT/RP_API_KEY, an Enigma vault credential, or `pipes login reportportal`");
	}
}

export interface PipesService {
	operationNames(): OperationName[];
	execute<Name extends OperationName>(op: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]>;
	/**
	 * Every ci.* operation projected onto Vehicle (see ../vehicle/pipes-vehicle.ts),
	 * replacing pi-pipes' old `ci(action=X)` mega-tool with one real Pi tool per
	 * operation.
	 */
	readonly vehicle: VehicleRegistry;
}

export const OPERATION_NAMES: OperationName[] = [
	"ci.help",
	"ci.status",
	"ci.log",
	"ci.search",
	"ci.discover",
	"ci.trigger",
	"ci.wait",
	"ci.cancel",
	"ci.stages",
	"ci.chain",
	"ci.pool",
	"ci.subscribed",
	"ci.subscribe",
	"ci.unsubscribe",
	"ci.tail",
	"ci.downstream",
	"ci.presets.list",
	"ci.presets.set",
	"ci.presets.remove",
	"rp.launches",
	"rp.launch",
	"rp.items",
	"rp.search",
	"rp.item",
	"rp.items.get",
	"rp.defects.update",
	"rp.dashboards",
	"rp.dashboard",
	"rp.dashboard.create",
	"rp.dashboard.widget.add",
];

export interface CreatePipesServiceOptions {
	/** Overridable for tests; production default is 15s, matching conty's wait ticker. */
	waitPollIntervalMs?: number;
	/** Optional: when present, trigger seeds the local pool and ci.pool reads from it. Absent in tests that don't exercise pooling. */
	runPool?: RunPool;
	/** Overridable for tests; production default is the same human-edited pipelines.json loadPresets reads at startup. */
	presetsPath?: string;
	/** Optional: when absent, every rp.* operation rejects with ReportPortalNotConfiguredError -- Report Portal is a single optional LaunchBackend, not a multi-adapter registry like Orchestrator's CIBackend map. */
	launchBackend?: LaunchBackend;
}

export function createPipesService(orchestrator: Orchestrator, options: CreatePipesServiceOptions = {}): PipesService {
	const pollIntervalMs = options.waitPollIntervalMs ?? DEFAULT_WAIT_POLL_MS;
	const pool = options.runPool;
	const presetsPath = options.presetsPath ?? defaultPresetsPath();
	let service!: PipesService;
	let cachedVehicleRegistry: VehicleRegistry | undefined;

	function launchBackend(): LaunchBackend {
		if (!options.launchBackend) throw new ReportPortalNotConfiguredError();
		return options.launchBackend;
	}

	async function handleStatus(input: OperationInputs["ci.status"]): Promise<OperationOutputs["ci.status"]> {
		if (input.pipeline) {
			return { pipelineRun: await orchestrator.getPipelineStatus(input.pipeline) };
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
			// Per-invocation override, merged onto every step's own baked-in params -- lets a preset
			// whose values legitimately change between runs (a release image, a branch) stay usable
			// without needing to be re-bookmarked just to update one value each time.
			const pipelineRun = await orchestrator.triggerPipeline(input.pipeline, input.params ?? {});
			if (pool) seedPoolFromPipelineRun(pool, orchestrator.pipelineBackendName(input.pipeline), pipelineRun);
			return { pipelineRun };
		}
		if (!input.backend || !input.jobRef) throw new Error("backend and jobRef are required when pipeline is not set");
		const result = await orchestrator.ciTrigger(input.backend, input.jobRef, input.params ?? {});
		if (pool && result.buildNumber) seedPoolFromTrigger(pool, input.backend, input.jobRef, result.buildNumber);
		return { result };
	}

	/** Idempotent: subscribing an already-watched job just re-seeds it with a fresh immediate fetch. */
	async function handleSubscribe(input: OperationInputs["ci.subscribe"]): Promise<OperationOutputs["ci.subscribe"]> {
		if (!pool) throw new Error("no local run pool is configured");
		const subscriberId = input.subscriberId ?? "";
		pool.subscribeJob(input.backend, input.jobRef, { subscriberId, scheduleMs: input.scheduleMs, runId: input.runId });
		// A pinned subscription's very first fetch must already reflect the pinned run, not "latest" --
		// this is the exact confusion a bare "latest" resolve caused live on a job with other concurrent triggers.
		const targetRunId = input.runId ?? "latest";
		try {
			const run = await orchestrator.ciGetRun(input.backend, input.jobRef, targetRunId);
			const log = await orchestrator.ciGetRawLog(input.backend, input.jobRef, run.id);
			const snapshot: RunSnapshot = {
				backend: input.backend,
				jobRef: input.jobRef,
				runId: run.id,
				status: run.status,
				result: run.result ?? "",
				url: run.url ?? "",
				startedAt: run.startedAt,
				durationMs: run.durationMs,
				fetchedAt: new Date(),
				watched: !isTerminalStatus(run.status),
			};
			pool.upsert(snapshot);
			pool.upsertLog(input.backend, input.jobRef, run.id, log);
			if (isTerminalStatus(run.status)) {
				// Only this call's own subscription -- a pinned run's own terminal status says nothing about
				// whether "latest" (or some other subscriber's pinned run) on the same job is also done.
				pool.unsubscribeJob(input.backend, input.jobRef, subscriberId);
			}
			return { subscribed: true, run: snapshot };
		} catch {
			// The job watch is still recorded -- the next background sync tick retries. Subscribing to a job that
			// doesn't exist yet (e.g. about to be triggered) is not itself an error.
			return { subscribed: true };
		}
	}

	function handleUnsubscribe(input: OperationInputs["ci.unsubscribe"]): OperationOutputs["ci.unsubscribe"] {
		pool?.unsubscribeJob(input.backend, input.jobRef, input.subscriberId);
		return { unsubscribed: true };
	}

	/** Explicit runId reuses a cached terminal (finished, won't change further) log; omitted runId always re-resolves "latest" live, matching the same autofocus the background sync applies. */
	async function handleTail(input: OperationInputs["ci.tail"]): Promise<OperationOutputs["ci.tail"]> {
		const maxTokens = input.maxTokens ?? DEFAULT_LOG_TAIL_TOKENS;

		if (input.runId && pool) {
			const cached = pool.get(input.backend, input.jobRef, input.runId);
			if (cached && isTerminalStatus(cached.status)) {
				const log = pool.getLog(input.backend, input.jobRef, input.runId) ?? "";
				const tail = tailByTokenBudget(log, maxTokens);
				return { runId: input.runId, status: cached.status, url: cached.url || undefined, ...tail };
			}
		}

		const run = input.runId
			? await orchestrator.ciGetRun(input.backend, input.jobRef, input.runId)
			: await orchestrator.ciGetRun(input.backend, input.jobRef, "latest");
		const log = await orchestrator.ciGetRawLog(input.backend, input.jobRef, run.id);
		if (pool) {
			pool.upsert({
				backend: input.backend,
				jobRef: input.jobRef,
				runId: run.id,
				status: run.status,
				result: run.result ?? "",
				url: run.url ?? "",
				startedAt: run.startedAt,
				durationMs: run.durationMs,
				fetchedAt: new Date(),
				watched: pool.isJobSubscribed(input.backend, input.jobRef) && !isTerminalStatus(run.status),
			});
			pool.upsertLog(input.backend, input.jobRef, run.id, log);
		}
		const tail = tailByTokenBudget(log, maxTokens);
		return { runId: run.id, status: run.status, url: run.url, ...tail };
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

	service = {
		operationNames(): OperationName[] {
			return OPERATION_NAMES;
		},
		get vehicle(): VehicleRegistry {
			// Built lazily, once, on first access -- createPipesVehicleRegistry(service) needs
			// this same service object, which doesn't exist yet at the point this literal is
			// being constructed. A dynamic import would be async for no reason; a plain
			// deferred require-once cache keeps this a plain synchronous getter.
			if (!cachedVehicleRegistry) cachedVehicleRegistry = createPipesVehicleRegistry(service);
			return cachedVehicleRegistry;
		},
		async execute<Name extends OperationName>(op: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]> {
			switch (op) {
				case "ci.pool": {
					const pooled = input as OperationInputs["ci.pool"];
					return { runs: pool ? pool.recent(pooled.backend, pooled.jobRef, pooled.limit ?? 20) : [] } as OperationOutputs[Name];
				}
				case "ci.subscribed":
					return { runs: pool ? pool.watchedRuns() : [] } as OperationOutputs[Name];
				case "ci.subscribe":
					return (await handleSubscribe(input as OperationInputs["ci.subscribe"])) as OperationOutputs[Name];
				case "ci.unsubscribe":
					return handleUnsubscribe(input as OperationInputs["ci.unsubscribe"]) as OperationOutputs[Name];
				case "ci.tail":
					return (await handleTail(input as OperationInputs["ci.tail"])) as OperationOutputs[Name];
				case "ci.downstream": {
					const downstream = input as OperationInputs["ci.downstream"];
					const runs = await orchestrator.ciDownstream(
						downstream.backend,
						downstream.downstreamJob,
						downstream.upstreamJob,
						downstream.upstreamRunId,
					);
					return { runs } as OperationOutputs[Name];
				}
				case "ci.help":
					return { backends: orchestrator.backendInfo(), pipelines: orchestrator.listPipelines() } as OperationOutputs[Name];
				case "ci.status":
					return (await handleStatus(input as OperationInputs["ci.status"])) as OperationOutputs[Name];
				case "ci.log":
					return (await handleLog(input as OperationInputs["ci.log"])) as OperationOutputs[Name];
				case "ci.search": {
					const search = input as OperationInputs["ci.search"];
					const { runs: builds, truncated } = await orchestrator.ciSearch(search.backend, search.jobRef, {
						result: search.result,
						runner: search.runner,
						since: search.since ? new Date(search.since) : undefined,
						limit: search.limit,
						params: search.params,
					});
					return { builds, truncated } as OperationOutputs[Name];
				}
				case "ci.discover": {
					const discover = input as OperationInputs["ci.discover"];
					if (discover.repo)
						return { workflows: await orchestrator.ciListWorkflows(discover.backend, discover.repo) } as OperationOutputs[Name];
					return { repos: await orchestrator.ciListRepos(discover.backend) } as OperationOutputs[Name];
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
					return (await orchestrator.ciChain(
						chain.backend,
						chain.jobRef,
						chain.runId,
						chain.depth ?? 3,
						chain.artifacts ?? false,
					)) as OperationOutputs[Name];
				}
				case "ci.presets.list":
					return { presets: orchestrator.listPipelineDefinitions() } as OperationOutputs[Name];
				case "ci.presets.set": {
					const { preset } = input as OperationInputs["ci.presets.set"];
					orchestrator.registerPipeline(preset);
					savePresets(presetsPath, orchestrator.listPipelineDefinitions());
					return { preset } as OperationOutputs[Name];
				}
				case "ci.presets.remove": {
					const { name } = input as OperationInputs["ci.presets.remove"];
					const removed = orchestrator.unregisterPipeline(name);
					if (removed) savePresets(presetsPath, orchestrator.listPipelineDefinitions());
					return { removed } as OperationOutputs[Name];
				}
				case "rp.launches": {
					const filter = input as OperationInputs["rp.launches"];
					const launches = await launchBackend().listLaunches({
						...filter,
						startAfter: filter.startAfter ? new Date(filter.startAfter) : undefined,
						startBefore: filter.startBefore ? new Date(filter.startBefore) : undefined,
					});
					return { launches } as OperationOutputs[Name];
				}
				case "rp.launch": {
					const { id } = input as OperationInputs["rp.launch"];
					return { launch: await launchBackend().getLaunch(id) } as OperationOutputs[Name];
				}
				case "rp.items": {
					const { launchId, filter } = input as OperationInputs["rp.items"];
					const items = await launchBackend().listTestItems(launchId, toTestItemFilter(filter));
					return { items } as OperationOutputs[Name];
				}
				case "rp.search": {
					const filter = input as OperationInputs["rp.search"];
					const items = await launchBackend().searchTestItems(toTestItemFilter(filter));
					return { items } as OperationOutputs[Name];
				}
				case "rp.item": {
					const { id } = input as OperationInputs["rp.item"];
					return { item: await launchBackend().getTestItem(id) } as OperationOutputs[Name];
				}
				case "rp.items.get": {
					const { ids } = input as OperationInputs["rp.items.get"];
					return { items: await launchBackend().getTestItems(ids) } as OperationOutputs[Name];
				}
				case "rp.defects.update": {
					const { updates } = input as OperationInputs["rp.defects.update"];
					await launchBackend().updateDefects(updates);
					return { updated: updates.length } as OperationOutputs[Name];
				}
				case "rp.dashboards":
					return { dashboards: await launchBackend().listDashboards() } as OperationOutputs[Name];
				case "rp.dashboard": {
					const { id } = input as OperationInputs["rp.dashboard"];
					return { dashboard: await launchBackend().getDashboard(id) } as OperationOutputs[Name];
				}
				case "rp.dashboard.create":
					return {
						dashboard: await launchBackend().createDashboard(input as OperationInputs["rp.dashboard.create"]),
					} as OperationOutputs[Name];
				case "rp.dashboard.widget.add": {
					const { dashboardId, ...widgetInput } = input as OperationInputs["rp.dashboard.widget.add"];
					return { widget: await launchBackend().addWidget(dashboardId, widgetInput) } as OperationOutputs[Name];
				}
				default:
					throw new UnknownOperationError(op);
			}
		},
	};
	return service;
}

/** Converts rp.items/rp.search's wire-shape TestItemFilter (ISO date strings) into the domain TestItemFilter (real Date objects), matching rp.launches' own ISO-string-over-RPC convention. */
function toTestItemFilter(filter: RpTestItemFilterInput | undefined): TestItemFilter {
	if (!filter) return {};
	return {
		...filter,
		since: filter.since ? new Date(filter.since) : undefined,
		before: filter.before ? new Date(filter.before) : undefined,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Seeds one row per resolved step so the background sync loop picks them up on its next tick, without waiting for a caller to ask ci.status first. */
/** Pins each step's auto-subscription to the exact run id that step itself produced, not "latest" -- same reasoning as seedPoolFromTrigger. */
function seedPoolFromPipelineRun(pool: RunPool, backend: string, pipelineRun: PipelineRun): void {
	const fetchedAt = new Date();
	for (const step of pipelineRun.steps) {
		if (!step.runId) continue;
		pool.subscribeJob(backend, step.jobName, { runId: step.runId });
		if (isTerminalStatus(step.status)) pool.unsubscribeJob(backend, step.jobName);
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
/** Pins the auto-subscription to the exact run this trigger just produced, not "latest" -- a shared job can have other unrelated concurrent triggers, and "latest" has no way to tell them apart from the run this call actually started. */
function seedPoolFromTrigger(pool: RunPool, backend: string, jobRef: string, runId: string): void {
	const now = new Date();
	pool.subscribeJob(backend, jobRef, { runId });
	pool.upsert({ backend, jobRef, runId, status: "pending", result: "", url: "", startedAt: now, fetchedAt: now, watched: true });
}

async function readOperationBody(request: Request): Promise<{ op?: unknown; input?: unknown }> {
	return (await request.json()) as { op?: unknown; input?: unknown };
}

function statusForError(error: unknown): number {
	if (error instanceof UnknownOperationError) return 404;
	return statusForKnownPipesError(error) ?? 400;
}

export function createApp(deps: { service: PipesService; token: string }): { fetch(request: Request): Promise<Response> } {
	// Same Bearer token, daemon, and port as the rest of this API.
	const vehicleApp = createVehicleHttpApp({ registry: deps.service.vehicle, token: deps.token });
	return {
		async fetch(request: Request): Promise<Response> {
			if (!requireBearerToken(request, deps.token)) {
				return errorResponse("missing or invalid bearer token", 401);
			}
			const url = new URL(request.url);
			if (url.pathname.startsWith("/vehicle/")) return vehicleApp.fetch(request);
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

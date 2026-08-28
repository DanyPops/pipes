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
import { registerVehicleProject, type VehicleProjectStore } from "@danypops/vehicle-server/project-scope";
import { errorResponse, healthResponse, jsonResponse, readyResponse, requireBearerToken } from "@danypops/vehicle-server/rpc-http";
import { defaultPresetsPath, savePresets } from "../config/presets.ts";
import { DEFAULT_LOG_TAIL_TOKENS } from "../constants.ts";
import type { Orchestrator } from "../orchestrator.ts";
import type { TestItemFilter } from "../reportportal/launch.ts";
import type { LaunchBackend } from "../reportportal/launch-backend.ts";
import {
	ARTIFACT_ARCHIVE_MAX_BYTES,
	ARTIFACT_LIST_DEFAULT_LIMIT,
	ARTIFACT_LIST_MAX_LIMIT,
	ARTIFACT_TEXT_DEFAULT_MAX_BYTES,
	ARTIFACT_TEXT_MAX_BYTES,
	artifactEntries,
	artifactText,
	assertArtifactArchiveBound,
	boundedArtifactInteger,
} from "../run/artifact-evidence.ts";
import type { LogResult, RunStatus } from "../run/ci-run.ts";
import type { PipelineRun } from "../run/pipeline.ts";
import { isTerminalStatus, type RunPool, type RunSnapshot } from "../sqlite/run-pool.ts";
import { tailByTokenBudget } from "../truncate.ts";
import { createPipesVehicleRegistry } from "../vehicle/pipes-vehicle.ts";
import { VERSION } from "../version.ts";
import { statusForKnownPipesError } from "./error-status.ts";
import type {
	OperationInputs,
	OperationName,
	OperationOutputs,
	PipesCallContext,
	PipesService,
	RpTestItemFilterInput,
} from "./operation-types.ts";

export type { OperationInputs, OperationName, OperationOutputs, PipesCallContext, PipesService, RpTestItemFilterInput };

const DEFAULT_WAIT_TIMEOUT_S = 3600;
const DEFAULT_WAIT_POLL_MS = 15_000;

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
	"ci.artifacts",
	"ci.artifact.entries",
	"ci.artifact.text",
	"ci.artifact.get",
	"ci.rerun",
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
	/** Optional: when present, ci.subscribe auto-registers (find-or-create) a project for a real
	 * callerProjectRoot, and ci.subscribed's own output attaches each row's project name. Absent in
	 * tests that don't exercise project scope -- registration is skipped, not an error, matching
	 * runPool's own optionality. */
	projectStore?: VehicleProjectStore;
}

/**
 * Surfaces the exact gap a real live session hit: a job this session is watching by repeatedly
 * calling ci.status/ci.tail (rather than one it itself triggered, or explicitly ci.subscribe'd to)
 * never shows up in that session's own "Jobs · N subscribed" widget, and the session has no signal
 * telling it that's fixable -- so it just keeps polling by hand instead. Only fires when there's a
 * real Pi session (callContext.callerSessionId) to subscribe as, the run is still non-terminal, and
 * that exact session isn't already subscribed -- never for a raw RPC client, a terminal run, or a
 * session that's already subscribed. Deliberately read-only: this never subscribes on the caller's
 * behalf (see ci.subscribed's own doc comment on why reads don't auto-derive/auto-mutate from
 * callContext) -- it only tells the caller (and, since these are LLM-facing tool results, the model
 * itself) that ci.subscribe is the better next move than calling this again.
 */
function subscribeNudgeFor(
	pool: RunPool | undefined,
	backend: string,
	jobRef: string,
	status: RunStatus,
	callContext?: PipesCallContext,
): string | undefined {
	if (!pool || !callContext?.callerSessionId) return undefined;
	if (isTerminalStatus(status)) return undefined;
	if (pool.isJobSubscribed(backend, jobRef, callContext.callerSessionId)) return undefined;
	return "This run is still in progress and this session hasn't subscribed to it -- call ci_subscribe once to get the Jobs widget and a background completion notice instead of polling ci_status/ci_tail again.";
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

	async function handleStatus(input: OperationInputs["ci.status"], callContext?: PipesCallContext): Promise<OperationOutputs["ci.status"]> {
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
		const note = subscribeNudgeFor(pool, input.backend, input.jobRef, verdict.check.status, callContext);
		if (note) out.note = note;
		return out;
	}

	async function handleLog(input: OperationInputs["ci.log"]): Promise<LogResult> {
		const filter = { tail: input.tail, grep: input.grep };
		if (input.pipeline) return orchestrator.getStepLog(input.pipeline, input.step ?? 0, filter);
		if (!input.backend || !input.jobRef) throw new Error("backend and jobRef are required when pipeline is not set");
		return orchestrator.ciLog(input.backend, input.jobRef, input.runId ?? "", filter);
	}

	async function handleTrigger(
		input: OperationInputs["ci.trigger"],
		callContext?: PipesCallContext,
	): Promise<OperationOutputs["ci.trigger"]> {
		// ci.trigger's own auto-subscribe is pure bookkeeping (the caller never passes a subscriberId/
		// projectRoot here -- ci.trigger's own input schema has neither field), so it's attributed the
		// exact same way ci.subscribe's own default is: this call's own real session id when present,
		// falling back to the shared anonymous subscriber for a raw RPC client with no session at all.
		// Without this, a job triggered from a live session never shows up in that same session's own
		// ci.subscribed({subscriberId}) view (e.g. the Jobs widget) until it's also explicitly
		// ci.subscribe'd -- a real, observed gap the multi-session scoping fix exposed.
		const subscriberId = callContext?.callerSessionId;
		const projectRoot = callContext?.callerProjectRoot;
		if (projectRoot && options.projectStore) registerVehicleProject(options.projectStore, { projectRoot });
		if (input.pipeline) {
			// Per-invocation override, merged onto every step's own baked-in params -- lets a preset
			// whose values legitimately change between runs (a release image, a branch) stay usable
			// without needing to be re-bookmarked just to update one value each time.
			const pipelineRun = await orchestrator.triggerPipeline(input.pipeline, input.params ?? {});
			if (pool) seedPoolFromPipelineRun(pool, orchestrator.pipelineBackendName(input.pipeline), pipelineRun, subscriberId, projectRoot);
			return { pipelineRun };
		}
		if (!input.backend || !input.jobRef) throw new Error("backend and jobRef are required when pipeline is not set");
		const result = await orchestrator.ciTrigger(input.backend, input.jobRef, input.params ?? {});
		if (pool && result.buildNumber) {
			seedPoolFromTrigger(pool, input.backend, input.jobRef, result.buildNumber, subscriberId, projectRoot);
		} else if (pool && result.opaqueRef) {
			pool.subscribeJob(input.backend, input.jobRef, { subscriberId, pendingOpaqueRef: result.opaqueRef, projectRoot });
		}
		return { result };
	}

	/**
	 * Idempotent: subscribing an already-watched job just re-seeds it with a fresh immediate fetch.
	 *
	 * Always pins to a concrete run id when one can be resolved -- even when the caller omitted
	 * runId. Resolving "latest" once, right now, and pinning to whatever that turns out to be gives
	 * the same convenience (no need to already know a run id) without the live bug this used to
	 * cause: leaving the subscription unpinned meant every later background sync tick re-resolved
	 * "latest" itself, so an unrelated concurrent trigger on the same job could silently steal an
	 * existing subscription mid-flight. Matches seedPoolFromTrigger/seedPoolFromPipelineRun, which
	 * already pin to the run id they just produced for exactly this reason.
	 */
	async function handleSubscribe(
		input: OperationInputs["ci.subscribe"],
		callContext?: PipesCallContext,
	): Promise<OperationOutputs["ci.subscribe"]> {
		if (!pool) throw new Error("no local run pool is configured");
		const subscriberId = input.subscriberId ?? callContext?.callerSessionId ?? "";
		const projectRoot = input.projectRoot ?? callContext?.callerProjectRoot;
		if (projectRoot && options.projectStore) registerVehicleProject(options.projectStore, { projectRoot });
		const targetRunId = input.runId ?? "latest";
		try {
			const run = await orchestrator.ciGetRun(input.backend, input.jobRef, targetRunId);
			pool.subscribeJob(input.backend, input.jobRef, { subscriberId, scheduleMs: input.scheduleMs, runId: run.id, projectRoot });
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
			// No run could be resolved yet (e.g. subscribing to a job that's about to be triggered) --
			// record the watch unpinned so the next background sync tick retries "latest" until a real
			// run appears. Not itself an error.
			pool.subscribeJob(input.backend, input.jobRef, { subscriberId, scheduleMs: input.scheduleMs, runId: input.runId, projectRoot });
			return { subscribed: true };
		}
	}

	function handleUnsubscribe(input: OperationInputs["ci.unsubscribe"]): OperationOutputs["ci.unsubscribe"] {
		pool?.unsubscribeJob(input.backend, input.jobRef, input.subscriberId);
		// run_snapshots.watched is a separate store from job_watches (see RunPool.clearWatchedForJob's
		// own doc comment) -- without this, ci.subscribed keeps listing this run as watched forever,
		// since nothing is left subscribed to ever poll it again and correct the stale flag.
		pool?.clearWatchedForJob(input.backend, input.jobRef);
		return { unsubscribed: true };
	}

	/** Explicit runId reuses a cached terminal (finished, won't change further) log; omitted runId always re-resolves "latest" live, matching the same autofocus the background sync applies. */
	async function handleTail(input: OperationInputs["ci.tail"], callContext?: PipesCallContext): Promise<OperationOutputs["ci.tail"]> {
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
		const note = subscribeNudgeFor(pool, input.backend, input.jobRef, run.status, callContext);
		return { runId: run.id, status: run.status, url: run.url, ...(note ? { note } : {}), ...tail };
	}

	/**
	 * Only when the caller's own subscription is pinned to exactly this run -- an unpinned (still
	 * tracking "latest") or differently-pinned subscription is left alone, since ci.wait's own
	 * answer says nothing about what either of those will eventually resolve to.
	 */
	function unsubscribeIfOwnPinnedMatch(backend: string, jobRef: string, runId: string, callContext: PipesCallContext | undefined): void {
		if (!pool) return;
		const subscriberId = callContext?.callerSessionId ?? "";
		const own = pool.watchedSubscriptions().find((s) => s.backend === backend && s.jobRef === jobRef && s.subscriberId === subscriberId);
		if (own?.pinnedRunId === runId) pool.unsubscribeJob(backend, jobRef, subscriberId);
	}

	/**
	 * Genuinely blocking: polls ciWatch on an interval until a terminal status or timeout, exactly
	 * like conty's wait action. Also clears the caller's own subscription once it's pinned to
	 * exactly this run -- a caller that both subscribed and waited on the same run already has the
	 * answer in hand, so leaving the subscription live would only produce a redundant, later
	 * background-sync notification for something the caller already knows.
	 */
	async function handleWait(input: OperationInputs["ci.wait"], callContext?: PipesCallContext): Promise<OperationOutputs["ci.wait"]> {
		if (input.opaqueRef) {
			if (!input.jobRef) throw new Error("wait requires jobRef with opaqueRef");
			return { buildNumber: await orchestrator.ciPoll(input.backend, input.jobRef, input.opaqueRef) };
		}
		if (!input.runId || !input.jobRef) {
			throw new Error("wait requires opaqueRef (resolve) or jobRef+runId (watch)");
		}
		const deadline = Date.now() + (input.timeoutS ?? DEFAULT_WAIT_TIMEOUT_S) * 1000;
		for (;;) {
			const status = await orchestrator.ciWatch(input.backend, input.jobRef, input.runId);
			if (status.status !== "running" && status.status !== "pending") {
				unsubscribeIfOwnPinnedMatch(input.backend, input.jobRef, input.runId, callContext);
				return status;
			}
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
		async execute<Name extends OperationName>(
			op: Name,
			input: OperationInputs[Name],
			callContext?: PipesCallContext,
		): Promise<OperationOutputs[Name]> {
			switch (op) {
				case "ci.pool": {
					const pooled = input as OperationInputs["ci.pool"];
					return { runs: pool ? pool.recent(pooled.backend, pooled.jobRef, pooled.limit ?? 20) : [] } as OperationOutputs[Name];
				}
				case "ci.subscribed": {
					const subscribed = input as OperationInputs["ci.subscribed"];
					return { runs: pool ? pool.watchedRunsWithProjectLabels(subscribed.subscriberId) : [] } as OperationOutputs[Name];
				}
				case "ci.subscribe":
					return (await handleSubscribe(input as OperationInputs["ci.subscribe"], callContext)) as OperationOutputs[Name];
				case "ci.unsubscribe":
					return handleUnsubscribe(input as OperationInputs["ci.unsubscribe"]) as OperationOutputs[Name];
				case "ci.tail":
					return (await handleTail(input as OperationInputs["ci.tail"], callContext)) as OperationOutputs[Name];
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
					return (await handleStatus(input as OperationInputs["ci.status"], callContext)) as OperationOutputs[Name];
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
					return (await handleTrigger(input as OperationInputs["ci.trigger"], callContext)) as OperationOutputs[Name];
				case "ci.wait":
					return (await handleWait(input as OperationInputs["ci.wait"], callContext)) as OperationOutputs[Name];
				case "ci.cancel": {
					const cancel = input as OperationInputs["ci.cancel"];
					await orchestrator.ciCancel(cancel.backend, cancel.jobRef, cancel.runId);
					return { status: "cancelled", runId: cancel.runId } as OperationOutputs[Name];
				}
				case "ci.stages":
					return (await handleStages(input as OperationInputs["ci.stages"])) as OperationOutputs[Name];
				case "ci.artifacts": {
					const artifacts = input as OperationInputs["ci.artifacts"];
					const limit = boundedArtifactInteger(
						artifacts.maxArtifacts ?? ARTIFACT_LIST_DEFAULT_LIMIT,
						1,
						ARTIFACT_LIST_MAX_LIMIT,
						"maxArtifacts",
					);
					const listed = await orchestrator.ciArtifacts(artifacts.backend, artifacts.jobRef, artifacts.runId);
					return { artifacts: listed.slice(0, limit), truncated: listed.length > limit } as OperationOutputs[Name];
				}
				case "ci.artifact.entries": {
					const artifact = input as OperationInputs["ci.artifact.entries"];
					const bytes = await orchestrator.ciArtifactGet(
						artifact.backend,
						artifact.jobRef,
						artifact.runId,
						artifact.path,
						ARTIFACT_ARCHIVE_MAX_BYTES,
					);
					assertArtifactArchiveBound(bytes);
					return artifactEntries(bytes, artifact.maxEntries) as OperationOutputs[Name];
				}
				case "ci.artifact.text": {
					const artifact = input as OperationInputs["ci.artifact.text"];
					const bytes = await orchestrator.ciArtifactGet(
						artifact.backend,
						artifact.jobRef,
						artifact.runId,
						artifact.path,
						ARTIFACT_ARCHIVE_MAX_BYTES,
					);
					assertArtifactArchiveBound(bytes);
					return artifactText(bytes, artifact.entry, artifact.maxBytes) as OperationOutputs[Name];
				}
				case "ci.artifact.get": {
					const artifact = input as OperationInputs["ci.artifact.get"];
					const maxBytes = artifact.maxBytes ?? ARTIFACT_TEXT_DEFAULT_MAX_BYTES;
					if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > ARTIFACT_TEXT_MAX_BYTES) {
						throw new Error(`maxBytes must be an integer from 1 to ${ARTIFACT_TEXT_MAX_BYTES}`);
					}
					const bytes = await orchestrator.ciArtifactGet(artifact.backend, artifact.jobRef, artifact.runId, artifact.path, maxBytes);
					if (bytes.length > maxBytes) throw new Error(`artifact exceeds maxBytes ${maxBytes}`);
					return { contentBase64: Buffer.from(bytes).toString("base64"), bytes: bytes.length } as OperationOutputs[Name];
				}
				case "ci.rerun": {
					const rerun = input as OperationInputs["ci.rerun"];
					await orchestrator.ciRerun(rerun.backend, rerun.jobRef, rerun.runId, rerun.failedOnly ?? false);
					if (pool) {
						const subscriberId = callContext?.callerSessionId ?? "";
						const projectRoot = callContext?.callerProjectRoot;
						if (projectRoot && options.projectStore) registerVehicleProject(options.projectStore, { projectRoot });
						pool.subscribeJob(rerun.backend, rerun.jobRef, { subscriberId, runId: rerun.runId, projectRoot });
					}
					return { status: "accepted", runId: rerun.runId } as OperationOutputs[Name];
				}
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
function seedPoolFromPipelineRun(
	pool: RunPool,
	backend: string,
	pipelineRun: PipelineRun,
	subscriberId?: string,
	projectRoot?: string,
): void {
	const fetchedAt = new Date();
	for (const step of pipelineRun.steps) {
		if (!step.runId) continue;
		pool.subscribeJob(backend, step.jobName, { runId: step.runId, subscriberId, projectRoot });
		if (isTerminalStatus(step.status)) pool.unsubscribeJob(backend, step.jobName, subscriberId);
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
function seedPoolFromTrigger(
	pool: RunPool,
	backend: string,
	jobRef: string,
	runId: string,
	subscriberId?: string,
	projectRoot?: string,
): void {
	const now = new Date();
	pool.subscribeJob(backend, jobRef, { runId, subscriberId, projectRoot });
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

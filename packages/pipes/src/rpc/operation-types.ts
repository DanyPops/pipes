/**
 * Shared operation-name/input/output/service-shape types -- used by both rpc/service.ts (the
 * dispatch implementation) and vehicle/pipes-vehicle.ts (the Vehicle projection), so neither
 * module needs to import the other for these. Living here is what breaks the
 * rpc/service.ts<->vehicle/pipes-vehicle.ts circular dependency: previously
 * vehicle/pipes-vehicle.ts `import type`-ed these back from rpc/service.ts, while
 * rpc/service.ts value-imported createPipesVehicleRegistry from vehicle/pipes-vehicle.ts.
 */
import type { VehicleRegistry } from "@danypops/vehicle-server";
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
import type { ArtifactEntry } from "../run/artifact-evidence.ts";
import type { CIArtifact, CIRunNode, CIStageNode, LogResult, RunResult } from "../run/ci-run.ts";
import type { RepoInfo, WorkflowInfo } from "../run/discovery.ts";
import type { Pipeline, PipelineRun } from "../run/pipeline.ts";
import type { TriggerResult, WatchStatus } from "../run/trigger.ts";
import type { RunSnapshot } from "../sqlite/run-pool.ts";

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
	| "ci.artifacts"
	| "ci.artifact.entries"
	| "ci.artifact.text"
	| "ci.artifact.get"
	| "ci.rerun"
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
	"ci.artifacts": { backend: string; jobRef: string; runId: string; maxArtifacts?: number };
	"ci.artifact.entries": { backend: string; jobRef: string; runId: string; path: string; maxEntries?: number };
	"ci.artifact.text": { backend: string; jobRef: string; runId: string; path: string; entry: string; maxBytes?: number };
	"ci.artifact.get": { backend: string; jobRef: string; runId: string; path: string; maxBytes?: number };
	"ci.rerun": { backend: string; jobRef: string; runId: string; failedOnly?: boolean };
	"ci.chain": { backend: string; jobRef: string; runId: string; depth?: number; artifacts?: boolean };
	"ci.pool": { backend: string; jobRef: string; limit?: number };
	/** Every currently-subscribed job across every backend/jobRef -- unlike ci.pool (one job's own recent
	 * history), this is the "what's subscribed right now" listing a jobs-overview widget polls.
	 * subscriberId, when given, scopes the result to only that subscriber's own watched jobs -- the
	 * fix for a real, proven cross-session leak where every Pi session's own jobs-overview widget
	 * saw (and got notified about) every OTHER session's subscribed jobs too, since this had no
	 * scoping input at all. Deliberately NOT auto-derived from callContext the way ci.subscribe/
	 * ci.unsubscribe default subscriberId -- this is a read, and an explicit tool call asking "what's
	 * subscribed" (e.g. the model itself, via the ci_subscribed tool) reasonably still wants the full
	 * global view by default; only a caller that explicitly wants its own scoped view (the jobs widget's
	 * own background poll) passes this. Omitted keeps today's global, unscoped view. */
	"ci.subscribed": { subscriberId?: string };
	/** subscriberId defaults to the calling Pi session's own real id (PipesCallContext.callerSessionId,
	 * auto-derived from context.sessionManager.getSessionId() -- see vehicle-client-pi's own doc comment)
	 * when the caller doesn't pass one explicitly, falling back further to "" -- the shared anonymous
	 * subscriber -- for a raw RPC client with no Pi session behind it at all. scheduleMs, when set, is
	 * this subscriber's own minimum check cadence; omitted checks on every background sync tick. runId,
	 * when set, pins this watch to that exact run forever instead of always re-resolving "latest" -- use
	 * this whenever you already have a concrete run id, especially on a job with other unrelated
	 * concurrent triggers. projectRoot defaults the same way from PipesCallContext.callerProjectRoot --
	 * the project this subscription gets attributed to for ci.subscribed's own display grouping. */
	"ci.subscribe": { backend: string; jobRef: string; subscriberId?: string; scheduleMs?: number; runId?: string; projectRoot?: string };
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
	/** note is present only when this run is still in progress and this call's own session (callContext.callerSessionId) hasn't subscribed to it yet -- see subscribeNudgeFor's own doc comment. */
	"ci.status": {
		pipelineRun?: PipelineRun;
		verdict?: unknown;
		params?: Record<string, string>;
		truncatedParamKeys?: string[];
		note?: string;
	};
	"ci.log": LogResult;
	/** truncated mirrors SearchResult.truncated -- true when the backend gave up at a page-cap safety valve before `since`/`limit` was conclusively satisfied. See run/ci-run.ts's SearchResult doc comment. */
	"ci.search": { builds: unknown[]; truncated: boolean };
	/** Exactly one of repos/workflows is present, matching which input.repo case was requested. */
	"ci.discover": { repos?: RepoInfo[]; workflows?: WorkflowInfo[] };
	"ci.trigger": { pipelineRun?: PipelineRun; result?: TriggerResult };
	"ci.wait": WatchStatus | { buildNumber: string };
	"ci.cancel": { status: "cancelled"; runId: string };
	"ci.stages": { stages: CIStageNode[] | Array<{ id: string; name: string; status: string; durationMs?: number }> };
	"ci.artifacts": { artifacts: CIArtifact[]; truncated: boolean };
	"ci.artifact.entries": { entries: ArtifactEntry[]; truncated: boolean };
	"ci.artifact.text": { text: string; bytes: number; truncated: false };
	"ci.artifact.get": { contentBase64: string; bytes: number };
	"ci.rerun": { status: "accepted"; runId: string };
	"ci.chain": CIRunNode;
	/** Reads only the local pool — never a live backend call, safe to call frequently. Empty when no pool is configured. */
	"ci.pool": { runs: RunSnapshot[] };
	/** Every currently-watched run (RunPool.watchedRunsWithProjectLabels()) -- never a live backend call,
	 * safe to poll frequently. Empty when no pool is configured. projectRoot/projectName are present when
	 * (a) the subscribing call carried a real project root (see ci.subscribe's own doc comment) and (b)
	 * that root was actually registered as a project (see PipesCallContext/registerVehicleProject) --
	 * absent for e.g. a raw RPC client's subscription, which has no project to attribute. */
	"ci.subscribed": { runs: Array<RunSnapshot & { projectRoot?: string; projectName?: string }> };
	/** Idempotent: seeds an immediate fetch and starts background refreshing that job's latest run. */
	"ci.subscribe": { subscribed: true; run?: RunSnapshot };
	/** Idempotent: no error if the job wasn't subscribed. */
	"ci.unsubscribe": { unsubscribed: true };
	/** note is present only when this run is still in progress and this call's own session (callContext.callerSessionId) hasn't subscribed to it yet -- see subscribeNudgeFor's own doc comment. */
	"ci.tail": {
		runId: string;
		status: string;
		text: string;
		truncated: boolean;
		totalTokens: number;
		outputTokens: number;
		url?: string;
		note?: string;
	};
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

/**
 * Per-invocation caller identity, generic across every operation -- mirrors
 * @danypops/vehicle-core's own VehicleOperationContext.callerSessionId/callerProjectRoot exactly
 * (see pipes-vehicle.ts's own operation loop for where these are read off a real Vehicle call and
 * forwarded here). Optional and additive: a raw RPC client (PipesClient, no Pi session behind it)
 * simply never supplies one, and every operation that doesn't care about caller identity ignores
 * it -- ci.subscribe/ci.subscribed/ci.trigger use it to attribute a subscription; ci.status/ci.tail
 * use it (read-only, see subscribeNudgeFor) to notice when *this* session is watching an in-progress
 * job it hasn't subscribed to and say so in the response.
 */
export interface PipesCallContext {
	readonly callerSessionId?: string;
	readonly callerProjectRoot?: string;
}

export interface PipesService {
	operationNames(): OperationName[];
	execute<Name extends OperationName>(
		op: Name,
		input: OperationInputs[Name],
		callContext?: PipesCallContext,
	): Promise<OperationOutputs[Name]>;
	/**
	 * Every ci.* operation projected onto Vehicle (see ../vehicle/pipes-vehicle.ts),
	 * replacing pi-pipes' old `ci(action=X)` mega-tool with one real Pi tool per
	 * operation.
	 */
	readonly vehicle: VehicleRegistry;
}

/**
 * Every real ci.* daemon operation projected as its own VehicleRegistry
 * entry, replacing pi-pipes' hand-rolled `ci(action=X)` mega-tool. Delegates
 * to the exact same PipesService.execute() the legacy /api/v1/ops dispatch
 * already calls (see ../rpc/service.ts) -- a projection layer on top of the
 * existing application logic, not a second copy of it.
 *
 * ci.wait is the one exception: its handler here runs the same short-tick
 * poll loop pi-pipes' client used to run itself (waitAndStreamTail), but
 * server-side, reporting each tick via context.reportProgress() -- Vehicle's
 * own SSE-on-invoke progress mechanism streams that to the calling Pi tool's
 * onUpdate generically, with no client-side polling code needed at all.
 */
import {
	bindVehicleOperation,
	defineErrorMapping,
	defineLooseObjectSchema,
	defineVehicleOperation,
	type LooseObjectProperty,
	passthroughVehicleSchema,
	type VehicleEffect,
} from "@danypops/vehicle-core";
import { VehicleRegistry } from "@danypops/vehicle-server";
import { VEHICLE_NAME } from "../constants.ts";
import { BackendUnavailableError } from "../orchestrator.ts";
import { statusForKnownPipesError } from "../rpc/error-status.ts";
import type { OperationInputs, OperationName, PipesService } from "../rpc/operation-types.ts";

const OWNER = "pipes";

const withPipesErrorParity = defineErrorMapping(
	[
		{ errorClass: BackendUnavailableError, category: "unavailable", code: "backend-unavailable" },
		{ matches: (error) => statusForKnownPipesError(error) === 404, category: "not_found" },
		{ matches: (error) => statusForKnownPipesError(error) === 403, category: "authorization" },
		{ matches: (error) => statusForKnownPipesError(error) === 400, category: "validation" },
	],
	{ fallbackCategory: "internal", fallbackCode: "handler-failed", fallbackMessage: "Pipes operation failed" },
);

const LIMITS = { defaultTimeoutMs: 10_000, maxTimeoutMs: 30_000, maxRequestBytes: 65_536, maxResponseBytes: 262_144 };

// ci.wait is the one operation that must genuinely run long: VehicleRegistry.invoke()'s own
// deadline clamp (effectiveDeadline = min(requested, now + limits.maxTimeoutMs)) reads
// limits.maxTimeoutMs unconditionally -- longRunning: true is descriptor metadata only, never
// consulted there. Sharing the generic read-operation LIMITS above meant ci.wait was aborted at
// 30s regardless of the timeoutS a caller requested, even though waitWithProgress's own tick loop
// budgets for up to WAIT_DEFAULT_TOTAL_TIMEOUT_S. maxTimeoutMs here covers that full budget plus
// one tick of slack so the loop's last in-flight tick isn't cut off right at the boundary.
const WAIT_TICK_TIMEOUT_S = 20;
const WAIT_DEFAULT_TOTAL_TIMEOUT_S = 3_600;
const WAIT_LIMITS = {
	...LIMITS,
	defaultTimeoutMs: WAIT_DEFAULT_TOTAL_TIMEOUT_S * 1_000,
	maxTimeoutMs: (WAIT_DEFAULT_TOTAL_TIMEOUT_S + WAIT_TICK_TIMEOUT_S) * 1_000,
};

const stringProp: LooseObjectProperty = { type: "string" };
const numberProp: LooseObjectProperty = { type: "number" };
const booleanProp: LooseObjectProperty = { type: "boolean" };
const objectProp: LooseObjectProperty = { type: "object" };

interface OperationSpec {
	readonly action: OperationName;
	readonly description: string;
	readonly effect: VehicleEffect;
	readonly properties: Record<string, LooseObjectProperty>;
	readonly required: readonly string[];
	readonly streaming?: boolean;
	readonly longRunning?: boolean;
	/** Overrides the shared LIMITS for this one operation -- see WAIT_LIMITS's own doc comment. */
	readonly limits?: typeof LIMITS;
}

const OPERATIONS: readonly OperationSpec[] = [
	{
		action: "ci.help",
		description: "Lists every configured backend and every bookmarked pipeline preset.",
		effect: "read",
		properties: {},
		required: [],
	},
	{
		action: "ci.status",
		description:
			'A run\'s current verdict: status plus, on failure, a classified cause and log excerpt in one call. Call with pipeline for a bookmarked preset, or backend+jobRef directly (GitLab: a job name; Jenkins: a folder-nested job path; GitHub: a workflow file name, or "repo/workflow.yml" for an account-scoped backend -- use ci_discover if unsure). runId is optional -- omit it for the latest run. Planning to check back on a still-running job across more than one turn? Call ci_subscribe once instead of re-polling this -- it gets the job onto the persistent Jobs widget and a background completion ping, and the response itself says so (via `note`) whenever it notices you doing that.',
		effect: "read",
		properties: {
			backend: stringProp,
			jobRef: { ...stringProp },
			runId: { ...stringProp, type: "string" },
			pipeline: stringProp,
			tail: numberProp,
			grep: stringProp,
			includeParams: booleanProp,
		},
		required: [],
	},
	{
		action: "ci.log",
		description: "Raw (optionally filtered) log text for one run or preset step.",
		effect: "read",
		properties: {
			backend: stringProp,
			jobRef: stringProp,
			runId: stringProp,
			pipeline: stringProp,
			step: numberProp,
			tail: numberProp,
			grep: stringProp,
		},
		required: [],
	},
	{
		action: "ci.search",
		description: "Searches a job's run history by result/runner/date/params.",
		effect: "read",
		properties: {
			backend: stringProp,
			jobRef: stringProp,
			result: stringProp,
			runner: stringProp,
			since: stringProp,
			limit: numberProp,
			params: objectProp,
		},
		required: ["backend", "jobRef"],
	},
	{
		action: "ci.discover",
		description:
			"Lists every repo an account-scoped GitHub backend's credential can see, or (with repo) that repo's workflow files. For Jenkins: lists top-level jobs/folders, or (with repo) one folder's child jobs -- a returned workflow's fileName is a real, immediately-usable jobRef (folder-nested where applicable). The way to build a real jobRef instead of guessing it. Fails clearly against a backend without discovery support (GitLab today).",
		effect: "read",
		properties: { backend: stringProp, repo: stringProp },
		required: ["backend"],
	},
	{
		action: "ci.trigger",
		description:
			"Starts a new run -- a real, externally visible CI trigger. Call with pipeline for a bookmarked preset (params override its own baked-in ones), or backend+jobRef directly.",
		effect: "external-write",
		properties: { backend: stringProp, jobRef: stringProp, pipeline: stringProp, params: objectProp },
		required: [],
	},
	{
		action: "ci.wait",
		description:
			"Blocks until a run reaches a terminal status or timeoutS elapses. Given backend+jobRef+runId (watching a real run), streams a live status+log-tail snapshot every ~20s while it waits. Given opaqueRef instead (resolving a fresh trigger's receipt to a real run id), returns once resolved with no streaming. Bounded by timeoutS -- if the run outlives it, this returns the last-known (still non-terminal) status rather than throwing, so a job that might run longer than you want to hold this call open for is better tracked with ci_subscribe (persistent, survives this call ending) than by calling ci_wait again. Already ci_subscribed to this exact run? No need to unsubscribe first -- reaching a terminal status here auto-clears that subscription so you don't also get a redundant background notification for an answer you already have.",
		effect: "read",
		properties: { backend: stringProp, jobRef: stringProp, runId: stringProp, opaqueRef: stringProp, timeoutS: numberProp },
		required: ["backend"],
		streaming: true,
		longRunning: true,
		limits: WAIT_LIMITS,
	},
	{
		action: "ci.cancel",
		description: "Cancels a running job -- a real, externally visible action.",
		effect: "external-write",
		properties: { backend: stringProp, jobRef: stringProp, runId: stringProp },
		required: ["backend", "jobRef", "runId"],
	},
	{
		action: "ci.stages",
		description: "A run's stage/step breakdown, optionally with each failed step's own log attached.",
		effect: "read",
		properties: { backend: stringProp, jobRef: stringProp, runId: stringProp, steps: booleanProp, includeFailedLog: booleanProp },
		required: ["backend", "jobRef", "runId"],
	},
	{
		action: "ci.chain",
		description:
			"A run's downstream tree, automatically, where the backend supports it (GitLab). Jenkins needs ci.downstream instead, since its bridges can't be discovered without already knowing the downstream job name.",
		effect: "read",
		properties: { backend: stringProp, jobRef: stringProp, runId: stringProp, depth: numberProp, artifacts: booleanProp },
		required: ["backend", "jobRef", "runId"],
	},
	{
		action: "ci.pool",
		description: "Reads only the daemon's own locally pooled run history -- never a live backend call, cheap to call frequently.",
		effect: "read",
		properties: { backend: stringProp, jobRef: stringProp, limit: numberProp },
		required: ["backend", "jobRef"],
	},
	{
		action: "ci.subscribed",
		description:
			"Every currently-subscribed job across every backend/jobRef -- never a live backend call, cheap to call frequently. Unlike ci.pool (one job's own recent history), this is the full 'what's subscribed right now' listing. subscriberId, when given, scopes the result to only that subscriber's own watched jobs instead of the global view -- e.g. a jobs-overview widget passing its own Pi session id so one session's notifications never leak into another's.",
		effect: "read",
		properties: { subscriberId: stringProp },
		required: [],
	},
	{
		action: "ci.subscribe",
		description:
			"Has the daemon keep following a job's run in the background -- auto-unsubscribes once terminal. Idempotent. ci.trigger already subscribes automatically, pinned to the run it produced. subscriberId scopes this watch to one caller (defaults to this calling Pi session's own real session id, then a shared anonymous subscriber for a raw RPC client with no session at all); scheduleMs bounds how often that subscriber's watch is refreshed, in milliseconds (omit to refresh on every background sync tick). runId pins the watch to that exact run; omit it and the watch auto-pins to whatever 'latest' resolves to right now, immune to a later unrelated trigger on the same job stealing it. projectRoot attributes this subscription to a project for ci.subscribed's own display grouping -- defaults to this calling session's own cwd; rarely needs to be passed explicitly.",
		effect: "local-write",
		properties: {
			backend: stringProp,
			jobRef: stringProp,
			subscriberId: stringProp,
			scheduleMs: numberProp,
			runId: stringProp,
			projectRoot: stringProp,
		},
		required: ["backend", "jobRef"],
	},
	{
		action: "ci.unsubscribe",
		description:
			"Stops the daemon following a job's runs in the background. Idempotent -- no error if it wasn't subscribed. subscriberId removes only that one caller's watch, leaving any other subscriber's own watch on the same job intact.",
		effect: "local-write",
		properties: { backend: stringProp, jobRef: stringProp, subscriberId: stringProp },
		required: ["backend", "jobRef"],
	},
	{
		action: "ci.tail",
		description:
			"A subscribed job's most recent cached log output, token-budgeted -- cheaper than ci.log for repeated polling. Explicit runId reuses a cached terminal log; omitted always re-resolves \"latest\" live. Still calling this on the same non-terminal run turn after turn? Call ci_subscribe once instead -- the Jobs widget and a background completion ping replace the need to keep re-tailing by hand, and the response's own `note` field will point this out whenever it applies.",
		effect: "read",
		properties: { backend: stringProp, jobRef: stringProp, runId: stringProp, maxTokens: numberProp },
		required: ["backend", "jobRef"],
	},
	{
		action: "ci.downstream",
		description:
			"Targeted downstream-job lookup for a backend (Jenkins) where ci.chain's automatic tree crawl can't discover children without already knowing the downstream job name.",
		effect: "read",
		properties: { backend: stringProp, downstreamJob: stringProp, upstreamJob: stringProp, upstreamRunId: stringProp },
		required: ["backend", "downstreamJob", "upstreamJob", "upstreamRunId"],
	},
	{
		action: "ci.presets.list",
		description:
			"Lists every bookmarked pipeline preset (name -> backend + ordered steps). This is a live daemon read: while the Pipes connector is unreachable it returns connector-unavailable rather than stale preset data; recovery preserves the server-side list without requiring presets to be recreated.",
		effect: "read",
		properties: {},
		required: [],
	},
	{
		action: "ci.presets.set",
		description:
			'Saves or overwrites a named pipeline preset, e.g. {name: "deploy", backend: "github", steps: [{jobName: "build"}, {jobName: "deploy", params: {env: "prod"}}]} -- once saved, ci.trigger/ci.status/ci.log can use it by name alone via the pipeline parameter.',
		effect: "local-write",
		properties: { preset: objectProp },
		required: ["preset"],
	},
	{
		action: "ci.presets.remove",
		description: "Removes a bookmarked preset by name.",
		effect: "local-write",
		properties: { name: stringProp },
		required: ["name"],
	},
	{
		action: "rp.launches",
		description: "Lists Report Portal launches (test-execution runs), optionally filtered by name/status/attributes/start-time range.",
		effect: "read",
		properties: {
			name: stringProp,
			status: stringProp,
			startAfter: stringProp,
			startBefore: stringProp,
			attributes: objectProp,
			limit: numberProp,
			page: numberProp,
		},
		required: [],
	},
	{
		action: "rp.launch",
		description: "Gets one Report Portal launch by id.",
		effect: "read",
		properties: { id: stringProp },
		required: ["id"],
	},
	{
		action: "rp.items",
		description: "Lists test items within one Report Portal launch.",
		effect: "read",
		properties: { launchId: stringProp, filter: objectProp },
		required: ["launchId"],
	},
	{
		action: "rp.search",
		description:
			"Searches test items across one or more Report Portal launches. Requires launchIds -- resolve launchName/since/before to launch ids via rp.launches first.",
		effect: "read",
		properties: {
			launchIds: objectProp,
			name: stringProp,
			status: objectProp,
			issueType: objectProp,
			includeLogs: booleanProp,
			includeSuites: booleanProp,
			limit: numberProp,
			page: numberProp,
		},
		required: [],
	},
	{
		action: "rp.item",
		description: "Gets one Report Portal test item by id.",
		effect: "read",
		properties: { id: stringProp },
		required: ["id"],
	},
	{
		action: "rp.items.get",
		description: "Gets several Report Portal test items by id in one call.",
		effect: "read",
		properties: { ids: objectProp },
		required: ["ids"],
	},
	{
		action: "rp.defects.update",
		description:
			"Bulk-updates defect classification (issue type/comment/linked tickets) on one or more Report Portal test items -- a real, externally visible write.",
		effect: "external-write",
		properties: { updates: objectProp },
		required: ["updates"],
	},
	{
		action: "rp.dashboards",
		description: "Lists Report Portal dashboards.",
		effect: "read",
		properties: {},
		required: [],
	},
	{
		action: "rp.dashboard",
		description: "Gets one Report Portal dashboard by id.",
		effect: "read",
		properties: { id: stringProp },
		required: ["id"],
	},
	{
		action: "rp.dashboard.create",
		description: "Creates a new Report Portal dashboard -- a real, externally visible write.",
		effect: "external-write",
		properties: { name: stringProp, description: stringProp },
		required: ["name"],
	},
	{
		action: "rp.dashboard.widget.add",
		description: "Adds a widget to a Report Portal dashboard -- a real, externally visible write.",
		effect: "external-write",
		properties: { dashboardId: stringProp, name: stringProp, type: stringProp, width: numberProp, height: numberProp },
		required: ["dashboardId", "name", "type"],
	},
];

/** Mirrors packages/pipes's own RunStatus terminal set (isTerminalStatus in run/ci-run.ts). */
const TERMINAL_STATUSES = new Set(["success", "failure", "aborted", "not_found"]);

/**
 * The "watch an existing run" form (jobRef+runId given, not opaqueRef): ticks
 * ci.wait with a short per-tick timeout budget, pairs each tick with ci.tail
 * for the log text ci.wait's own shape doesn't carry, and reports the
 * combined snapshot via reportProgress on every tick. The opaqueRef-resolve
 * form (turning a fresh trigger's receipt into a real run id) has no run to
 * tail yet, so it falls through to a single plain ci.wait call below instead.
 */
async function waitWithProgress(
	service: PipesService,
	input: OperationInputs["ci.wait"],
	reportProgress: (progress: unknown) => void,
	signal: AbortSignal,
): Promise<unknown> {
	if (!input.backend || !input.jobRef || !input.runId || input.opaqueRef) return service.execute("ci.wait", input);

	const backend = input.backend;
	const jobRef = input.jobRef;
	const runId = input.runId;
	const deadline = Date.now() + (input.timeoutS ?? WAIT_DEFAULT_TOTAL_TIMEOUT_S) * 1_000;
	let result: Record<string, unknown> = {};

	for (;;) {
		if (signal.aborted || Date.now() >= deadline) break;

		const remainingS = Math.max(1, Math.ceil((deadline - Date.now()) / 1_000));
		const tickTimeoutS = Math.min(WAIT_TICK_TIMEOUT_S, remainingS);

		const status = await service.execute("ci.wait", { backend, jobRef, runId, timeoutS: tickTimeoutS });
		const tail = await service.execute("ci.tail", { backend, jobRef, runId });
		result = { ...status, tail };
		reportProgress(result);

		const runStatus = (status as { status?: unknown }).status;
		if (typeof runStatus === "string" && TERMINAL_STATUSES.has(runStatus)) break;
	}

	return result;
}

export function createPipesVehicleRegistry(service: PipesService): VehicleRegistry {
	const registry = new VehicleRegistry({
		name: VEHICLE_NAME,
		packageJsonUrl: new URL("../../package.json", import.meta.url),
		description: "Cross-platform CI operations across GitHub Actions, GitLab CI, Jenkins, and Prow.",
	});
	// Every handler passes through the reviewed mapper above; unmatched failures stay redacted.
	registry.setExposeHandlerFailureDetails(true);

	for (const spec of OPERATIONS) {
		const operation = defineVehicleOperation({
			name: spec.action,
			version: 1,
			description: spec.description,
			input: defineLooseObjectSchema(spec.properties, spec.required),
			output: passthroughVehicleSchema,
			permissions: ["pipes:read", "pipes:write"],
			effect: spec.effect,
			idempotency: { mode: spec.effect === "read" ? "safe" : "unsafe" },
			streaming: spec.streaming,
			longRunning: spec.longRunning,
			limits: spec.limits ?? LIMITS,
		});
		registry.register(
			OWNER,
			bindVehicleOperation(
				operation,
				() => async (context) =>
					withPipesErrorParity(() => {
						if (spec.action === "ci.wait") {
							return waitWithProgress(service, context.input as OperationInputs["ci.wait"], context.reportProgress, context.signal);
						}
						// See @danypops/vehicle-core's own doc comment on callerSessionId/callerProjectRoot --
						// auto-derived by vehicle-client-pi from this real call's own Pi session/cwd. Forwarded
						// generically to every operation (most ignore it); ci.subscribe/ci.subscribed are the
						// only ones that read it today.
						return service.execute(spec.action, context.input as never, {
							callerSessionId: context.callerSessionId,
							callerProjectRoot: context.callerProjectRoot,
						});
					}),
			),
		);
	}

	return registry;
}

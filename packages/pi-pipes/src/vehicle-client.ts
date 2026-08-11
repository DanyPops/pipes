/**
 * Registers every real ci.* operation as its own Vehicle-projected Pi tool
 * (ci_status, ci_trigger, ci_wait, ...) instead of the old hand-rolled
 * `ci(action=X)` mega-tool -- see @danypops/pipes' own src/vehicle/pipes-vehicle.ts
 * for the VehicleRegistry side. Same daemon, same handle file, same Bearer
 * token every other Pipes RPC call already uses.
 *
 * ci_wait needs no client-side polling/streaming code at all: its daemon-side
 * handler (see pipes-vehicle.ts's waitWithProgress) reports each tick via
 * context.reportProgress(), and registerVehicleTools' generic execute()
 * wiring already forwards that to Pi's own onUpdate -- the exact mechanism
 * this migration set out to evaluate.
 *
 * Deliberately does NOT spawn the daemon: resolveVehicleClientTarget only
 * reads the handle if the daemon has already started, matching this
 * package's own established rule (see pipes-tui.ts's connectOrStartPipesClient,
 * which IS allowed to spawn, because it's triggered by an explicit /pipes
 * command, never a passive session_start hook).
 *
 * Uses ci-render.ts's existing renderResultText for every operation's result
 * view via the per-operation renderers option, so this migration keeps the
 * exact same hand-tuned rendering the mega-tool already had.
 */
import { join } from "node:path";
import {
	resolvePipesCredentialPaths,
	resolvePipesPaths,
	resolveVehicleClientTarget,
	VEHICLE_NAME,
	type VehicleClientTarget,
} from "@danypops/pipes";
import { createReconnectingVehicleClient } from "@danypops/vehicle-client/daemon-client";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import {
	type RegisteredPiVehicle,
	type RegisterVehicleToolsOptions,
	refreshVehicleToolAvailability,
	registerVehicleTools,
} from "@danypops/vehicle-client-pi";
import { registerVehicleStatusRefresh } from "@danypops/vehicle-client-pi/pi-status-refresh";
import type { AtomicJsonFsAdapter, VehicleClient } from "@danypops/vehicle-core";
import { createNodeAtomicJsonFsAdapter } from "@danypops/vehicle-server/atomic-json";
import { ProgressBar, type ProgressBarGlyphStyle, type ProgressBarGlyphs, statelessComponent } from "malevich-tui-components";

/**
 * Same directory pipes' own credential files already live in (resolvePipesCredentialPaths) --
 * one extra small JSON file, not a new storage location. Lets registerVehicleTools() register
 * ci_* tools and their renderers from the last successfully-fetched manifest when the daemon
 * is unreachable at factory time (a crash-loop, a slow restart after a reload) instead of
 * throwing and silently registering nothing for the rest of the session -- see the
 * manifestCache option on RegisterVehicleToolsOptions.
 */
function resolveManifestCachePath(): string {
	return join(resolvePipesCredentialPaths(resolvePipesPaths()).credentialsDir, "vehicle-manifest-cache.json");
}

import type { AgentToolResult, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { clampDisplayPercent, effectiveWatchPercent, findFirstUrl, openLine, renderResultText } from "./ci-render.ts";
import { withConnectorDiagnostics } from "./connector-diagnostics.ts";

export { withConnectorDiagnostics } from "./connector-diagnostics.ts";

/** Every Vehicle-projected tool name starts with "ci_" (ci_help, ci_status, ci_presets_list, ...) or "rp_" (rp_launches, rp_search, ...) -- one prefix per daemon operation namespace (see ../../pipes/src/rpc/service.ts's OperationName). */
export const PIPES_TOOL_PREFIXES = ["ci_", "rp_"];

/** Boot active with no tools_man call needed -- the handful of operations actually exercised
 * every session, mirroring papyrus's own CORE_OPERATIONS selection (vehicle-notes-client.ts).
 * Everything else (rp.*, ci.presets.*, ci.chain, ...) boots inactive, reachable via tools_man. */
const PIPES_CORE_OPERATIONS = ["ci.status", "ci.log", "ci.wait", "ci.trigger", "ci.subscribe", "ci.tail"];

export function isPipesVehicleTool(toolName: string): boolean {
	return PIPES_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

function renderCiCall(operationName: string, args: unknown, theme: Theme) {
	const input = args as { backend?: string; jobRef?: string; pipeline?: string; runId?: string } | undefined;
	// operationName is always "<namespace>.<action>" (ci.status, rp.launches, ...) -- split on the
	// first dot rather than assuming the "ci." namespace specifically, so a Report Portal (rp.*)
	// operation renders with its own real namespace instead of a mis-sliced fragment of its action.
	const dot = operationName.indexOf(".");
	const namespace = dot === -1 ? operationName : operationName.slice(0, dot);
	const action = dot === -1 ? operationName : operationName.slice(dot + 1);
	let text = theme.fg("toolTitle", theme.bold(`${namespace} `)) + theme.fg("muted", action);
	if (input?.pipeline) {
		text += ` ${theme.fg("accent", input.pipeline)}`;
	} else {
		const target = [input?.backend, input?.jobRef].filter(Boolean).join("/");
		if (target) text += ` ${theme.fg("accent", target)}`;
	}
	if (input?.runId) text += ` ${theme.fg("dim", `#${input.runId}`)}`;
	return new Text(text, 0, 0);
}

/**
 * Per-tool-call ci_wait animation state, stashed under a namespaced key on Pi's own
 * ToolRenderContext.state ("Shared renderer state for this tool row" -- the same object
 * reference every renderResult call for one toolCallId receives, per pi-coding-agent's
 * docs/tui.md). A fresh setInterval-driven ease-out tween is started every time the daemon
 * reports a new target percent, and *always* self-terminates once it reaches that target --
 * never left running past a finished/discarded tool row, no explicit teardown hook required.
 */
interface CiWaitAnimState {
	displayPercent?: number;
	animation?: { from: number; to: number; startedAt: number };
	timer?: ReturnType<typeof setInterval>;
}

const CI_WAIT_ANIM_DURATION_MS = 450;
const CI_WAIT_ANIM_TICK_MS = 50;

function easeOutCubic(t: number): number {
	return 1 - (1 - t) ** 3;
}

function ciWaitAnimState(state: unknown): CiWaitAnimState {
	// A real ToolRenderContext.state is always an object (tool-execution.ts initializes it per
	// row), but a test double or a future context shape may omit it entirely -- fall back to a
	// fresh, unpersisted object rather than throwing; the render still works, just without the
	// animation carrying over between calls.
	if (!state || typeof state !== "object") return {};
	const container = state as { ciWaitProgress?: CiWaitAnimState };
	if (!container.ciWaitProgress) container.ciWaitProgress = {};
	return container.ciWaitProgress;
}

/**
 * Advances (or starts) the ease-out tween toward `targetPercent` and returns the percent to
 * actually display this frame -- the bar and the "xx%" text both read this instead of the raw,
 * possibly-just-jumped-30-points server value, so a ci_wait tick reads as the bar climbing over
 * ~450ms rather than snapping. A settled (non-partial) result stops any in-flight tween and
 * jumps straight to the final value -- nothing left to animate toward once the run is done.
 */
function tickCiWaitProgress(state: CiWaitAnimState, targetPercent: number, isPartial: boolean, invalidate: () => void): number {
	const target = clampDisplayPercent(targetPercent);

	if (!isPartial) {
		if (state.timer !== undefined) {
			clearInterval(state.timer);
			state.timer = undefined;
		}
		state.displayPercent = target;
		return target;
	}

	// The very first tick this tool call has ever reported has nothing to climb *from* -- show it
	// immediately rather than manufacturing a fake 0%-start intro animation. Every later tick, once
	// displayPercent already reflects somewhere real, does get the eased climb.
	if (state.displayPercent === undefined) {
		state.displayPercent = target;
		return state.displayPercent;
	}
	if (!state.animation || state.animation.to !== target) {
		state.animation = { from: state.displayPercent, to: target, startedAt: Date.now() };
	}

	if (state.timer === undefined) {
		state.timer = setInterval(() => {
			const animation = state.animation;
			if (!animation) {
				clearInterval(state.timer);
				state.timer = undefined;
				return;
			}
			const t = Math.min(1, (Date.now() - animation.startedAt) / CI_WAIT_ANIM_DURATION_MS);
			state.displayPercent = animation.from + (animation.to - animation.from) * easeOutCubic(t);
			if (t >= 1) {
				clearInterval(state.timer);
				state.timer = undefined;
			}
			invalidate();
		}, CI_WAIT_ANIM_TICK_MS);
	}

	return state.displayPercent;
}

function renderCiResult(
	result: AgentToolResult<unknown>,
	isPartial: boolean,
	isError: boolean,
	theme: Theme,
	progressBarGlyphs: ProgressBarGlyphs | ProgressBarGlyphStyle,
	animState: CiWaitAnimState | undefined,
	invalidate: () => void,
) {
	const details = result.details as { output?: unknown; progress?: unknown } | undefined;
	const live = details?.progress ?? details?.output;
	const liveRecord = live && typeof live === "object" ? (live as Record<string, unknown>) : undefined;
	const rawPercent = typeof liveRecord?.progressPercent === "number" ? liveRecord.progressPercent : undefined;
	// A terminal WatchStatus.progressPercent is actual-vs-estimated-duration, not "percent done" --
	// see effectiveWatchPercent's own doc comment. Resolve that *before* handing a target to the
	// tween, so a run that settles at (say) 92% of its estimate still animates the rest of the way
	// to a full 100% bar instead of freezing next to its own ✓ success glyph.
	const targetPercent =
		rawPercent === undefined
			? undefined
			: typeof liveRecord?.status === "string"
				? effectiveWatchPercent(liveRecord.status, rawPercent)
				: rawPercent;

	if (targetPercent === undefined) {
		let text = renderResultText(result, isPartial, isError, theme);
		const data = details?.output;
		if (data !== undefined) {
			const url = findFirstUrl(data);
			if (url) text += `\n${openLine(url, theme)}`;
		}
		return new Text(text, 0, 0);
	}

	// Kick off (or retarget) the tween now, as a side effect of this render pass -- but the actual
	// displayed value below is always read fresh from animState at render(width) time, since this
	// same Component gets re-rendered by the tween's own invalidate() calls without renderCiResult
	// necessarily running again in between.
	if (animState) tickCiWaitProgress(animState, targetPercent, isPartial, invalidate);

	return statelessComponent((width) => {
		const shown = animState?.displayPercent ?? clampDisplayPercent(targetPercent);
		let text = renderResultText(result, isPartial, isError, theme, shown);
		const data = details?.output;
		if (data !== undefined) {
			const url = findFirstUrl(data);
			if (url) text += `\n${openLine(url, theme)}`;
		}
		const summary = new Text(text, 0, 0).render(width);
		const bar = new ProgressBar({
			value: shown,
			max: 100,
			glyphs: progressBarGlyphs,
			style: (line) => theme.fg("accent", line),
		});
		return [summary[0] ?? "", ...bar.render(width), ...summary.slice(1)];
	});
}

const PROGRESS_BAR_STYLES = new Set<ProgressBarGlyphStyle>(["shade", "smooth", "blocks", "ascii"]);

export function resolvePipesProgressBarStyle(value = process.env.PIPES_PROGRESS_BAR_STYLE): ProgressBarGlyphStyle {
	return value && PROGRESS_BAR_STYLES.has(value as ProgressBarGlyphStyle) ? (value as ProgressBarGlyphStyle) : "blocks";
}

export interface PipesVehicleDeps {
	/** Overridden in tests instead of reading a real daemon handle file. */
	resolveTarget?: () => VehicleClientTarget | undefined;
	/** Overridden in tests instead of constructing a real HTTP client. */
	createClient?: (target: VehicleClientTarget) => VehicleClient;
	/** Overridden in tests instead of touching the real on-disk manifest cache -- see resolveManifestCachePath's own doc comment. Omit at the call site (not here) to disable manifest caching entirely; this default is only for hermetic tests. */
	manifestCache?: { filePath: string; fs: AtomicJsonFsAdapter };
	/** Human-selected progress glyphs. Defaults to PIPES_PROGRESS_BAR_STYLE, then the bordered `blocks` style. */
	progressBarGlyphs?: ProgressBarGlyphs | ProgressBarGlyphStyle;
	/** Overridden in tests that need shell mode off to isolate an unrelated behavior -- pass `shell: undefined`
	 * explicitly to disable it. Omitting this field entirely (not present on deps at all) keeps the real
	 * default: core operations active, everything else behind tools_man, broker mode on under VEHICLE_NAME. */
	shell?: RegisterVehicleToolsOptions["shell"];
}

const DEFAULT_SHELL_OPTIONS: RegisterVehicleToolsOptions["shell"] = {
	coreOperations: PIPES_CORE_OPERATIONS,
	broker: { ownVehicleName: VEHICLE_NAME },
};

export async function registerPipesVehicle(pi: ExtensionAPI, deps: PipesVehicleDeps = {}): Promise<RegisteredPiVehicle | undefined> {
	const resolveTarget = deps.resolveTarget ?? resolveVehicleClientTarget;
	const target = resolveTarget();
	if (!target) return undefined;

	const createClient = deps.createClient ?? ((t: VehicleClientTarget) => new RemoteVehicleClient({ baseUrl: t.baseUrl, token: t.token }));
	const manifestCache = deps.manifestCache ?? { filePath: resolveManifestCachePath(), fs: createNodeAtomicJsonFsAdapter() };
	const progressBarGlyphs = deps.progressBarGlyphs ?? resolvePipesProgressBarStyle();
	try {
		// Re-resolves resolveTarget()/createClient fresh on every reconnect attempt rather than
		// closing over the `target` captured above: the daemon rebinds a new random port on every
		// restart, and a bare client built once has no way to notice its baseUrl died.
		const client = withConnectorDiagnostics(
			createReconnectingVehicleClient(async () => {
				const resolved = resolveTarget();
				if (!resolved) throw new Error("Pipes daemon is not running");
				return createClient(resolved);
			}),
		);
		const options: RegisterVehicleToolsOptions = {
			permissions: ["pipes:read", "pipes:write"],
			principal: { id: "pi-pipes" },
			shell: "shell" in deps ? deps.shell : DEFAULT_SHELL_OPTIONS,
			renderers: (descriptor) => ({
				renderCall: (args, theme) => renderCiCall(descriptor.name, args, theme),
				renderResult: (result, resultOptions, theme, context) =>
					renderCiResult(
						result as AgentToolResult<unknown>,
						resultOptions.isPartial,
						context.isError,
						theme,
						progressBarGlyphs,
						ciWaitAnimState(context.state),
						context.invalidate,
					),
			}),
			// A crash-loop or slow restart at factory time (Pi awaits this before transcript replay)
			// used to leave every ci_* tool unregistered for the rest of the session -- see the
			// manifestCache doc comment on RegisterVehicleToolsOptions.
			manifestCache,
		};
		let registered = await registerVehicleTools(pi, client, options);

		registerVehicleStatusRefresh(pi, {
			ownToolPrefixes: PIPES_TOOL_PREFIXES,
			refresh: async () => {
				registered = await refreshVehicleToolAvailability(pi, client, registered, options);
			},
		});

		return registered;
	} catch {
		// Daemon state stale/unreachable between resolveTarget() and the real manifest fetch --
		// degrade silently, matching pipes-tui.ts's own tolerance for the same condition.
		return undefined;
	}
}

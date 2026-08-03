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
import { resolveVehicleClientTarget, type VehicleClientTarget } from "@danypops/pipes";
import { createReconnectingVehicleClient } from "@danypops/vehicle-client/daemon-client";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import {
	type RegisteredPiVehicle,
	type RegisterVehicleToolsOptions,
	refreshVehicleToolAvailability,
	registerVehicleTools,
} from "@danypops/vehicle-client-pi";
import { registerVehicleStatusRefresh } from "@danypops/vehicle-client-pi/pi-status-refresh";
import type { VehicleClient } from "@danypops/vehicle-core";
import type { AgentToolResult, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { findFirstUrl, openLine, renderResultText } from "./ci-render.ts";

/** Every Vehicle-projected ci tool name starts with "ci_" (ci_help, ci_status, ci_presets_list, ...). */
export const PIPES_TOOL_PREFIXES = ["ci_"];

export function isPipesVehicleTool(toolName: string): boolean {
	return PIPES_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

function renderCiCall(operationName: string, args: unknown, theme: Theme) {
	const input = args as { backend?: string; jobRef?: string; pipeline?: string; runId?: string } | undefined;
	const action = operationName.slice("ci.".length);
	let text = theme.fg("toolTitle", theme.bold("ci ")) + theme.fg("muted", action);
	if (input?.pipeline) {
		text += ` ${theme.fg("accent", input.pipeline)}`;
	} else {
		const target = [input?.backend, input?.jobRef].filter(Boolean).join("/");
		if (target) text += ` ${theme.fg("accent", target)}`;
	}
	if (input?.runId) text += ` ${theme.fg("dim", `#${input.runId}`)}`;
	return new Text(text, 0, 0);
}

function renderCiResult(result: AgentToolResult<unknown>, isPartial: boolean, isError: boolean, theme: Theme) {
	let text = renderResultText(result, isPartial, isError, theme);
	const data = (result.details as { output?: unknown } | undefined)?.output;
	if (data !== undefined) {
		const url = findFirstUrl(data);
		if (url) text += `\n${openLine(url, theme)}`;
	}
	return new Text(text, 0, 0);
}

export interface PipesVehicleDeps {
	/** Overridden in tests instead of reading a real daemon handle file. */
	resolveTarget?: () => VehicleClientTarget | undefined;
	/** Overridden in tests instead of constructing a real HTTP client. */
	createClient?: (target: VehicleClientTarget) => VehicleClient;
}

export async function registerPipesVehicle(pi: ExtensionAPI, deps: PipesVehicleDeps = {}): Promise<RegisteredPiVehicle | undefined> {
	const resolveTarget = deps.resolveTarget ?? resolveVehicleClientTarget;
	const target = resolveTarget();
	if (!target) return undefined;

	const createClient = deps.createClient ?? ((t: VehicleClientTarget) => new RemoteVehicleClient({ baseUrl: t.baseUrl, token: t.token }));
	try {
		// Re-resolves resolveTarget()/createClient fresh on every reconnect attempt rather than
		// closing over the `target` captured above: the daemon rebinds a new random port on every
		// restart, and a bare client built once has no way to notice its baseUrl died.
		const client = createReconnectingVehicleClient(async () => {
			const resolved = resolveTarget();
			if (!resolved) throw new Error("Pipes daemon is not running");
			return createClient(resolved);
		});
		const options: RegisterVehicleToolsOptions = {
			permissions: ["pipes:read", "pipes:write"],
			principal: { id: "pi-pipes" },
			renderers: (descriptor) => ({
				renderCall: (args, theme) => renderCiCall(descriptor.name, args, theme),
				renderResult: (result, resultOptions, theme, context) =>
					renderCiResult(result as AgentToolResult<unknown>, resultOptions.isPartial, context.isError, theme),
			}),
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

/**
 * /pipes: human-driven TUI menu, mirroring pi-enigma's /secrets structure --
 * a backend/preset picker -> job picker -> action picker for manual
 * trigger/cancel/log-viewing and preset management, distinct from the
 * agent-facing ci tool (ci-tool.ts). No LLM involvement here at all: this is
 * a registerCommand handler, never a registerTool.
 *
 * Reuses ci-tool.ts's summarize()/ci-render.ts's findFirstUrl()/openLine()
 * so a human reading a result here sees the exact same compact, colored
 * rendering (and the same clickable URL) the ci tool's own TUI row shows.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { BorderedSelectPanel } from "malevich-tui-components";
import { findFirstUrl, openLine } from "./ci-render.ts";
import { summarize } from "./ci-tool.ts";
import type { PipesClient } from "./daemon-client.ts";
import { showRunDetailView, type RunDetailData } from "./run-detail-view.ts";
interface BackendInfo {
	name: string;
	type: string;
	capabilities?: string;
}

interface PresetInfo {
	name: string;
	backend: string;
	steps: Array<{ jobName: string; params?: Record<string, string> }>;
}

const ACTION_RUN_PRESET_PREFIX = "run-preset:";
const ACTION_TRIGGER_DIRECT = "__pipes_trigger_direct__";
const ACTION_MANAGE_RUN = "__pipes_manage_run__";
const ACTION_MANAGE_PRESETS = "__pipes_manage_presets__";
const ACTION_ADD_PRESET = "__pipes_add_preset__";
const ACTION_VIEW_PRESET_PREFIX = "view-preset:";
const ACTION_BACK = "__pipes_back__";

/** "key=value, key2 = value2" -> {key: value, key2: value2}. Blank segments are skipped; a segment with no "=" is skipped rather than throwing on bad input. */
export function parseParams(text: string): Record<string, string> {
	const params: Record<string, string> = {};
	for (const segment of text.split(",")) {
		const trimmed = segment.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const key = trimmed.slice(0, eq).trim();
		const value = trimmed.slice(eq + 1).trim();
		if (key) params[key] = value;
	}
	return params;
}

export function isTriggerable(backend: BackendInfo): boolean {
	return (backend.capabilities ?? "").split(/\s+/).includes("trigger");
}

export function describePreset(preset: PresetInfo): string {
	return `${preset.backend} \u2014 ${preset.steps.length} step(s): ${preset.steps.map((s) => s.jobName).join(", ")}`;
}

/**
 * Generic picker, built on malevich-tui-components' BorderedSelectPanel -- the same
 * border+title+list+help scaffold this file used to hand-roll independently (its own
 * prior doc comment noted it was "identical in shape to pi-enigma's own pickFromList";
 * Malevich's own doc comment confirms the same scaffold was duplicated across five real
 * codebases before being formalized there). A bordered SelectList in TUI mode, a plain
 * notify listing in non-TUI mode.
 */
export async function pickFromList(ctx: ExtensionCommandContext, title: string, items: SelectItem[], helpText: string): Promise<string | null> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`${title}: ${items.map((item) => item.label).join(", ") || "(none)"}`, "info");
		return null;
	}
	return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const selectList = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		const panel = new BorderedSelectPanel({
			title,
			list: selectList,
			helpText,
			theme: {
				border: (s: string) => theme.fg("accent", s),
				title: (s: string) => theme.fg("accent", theme.bold(s)),
				help: (s: string) => theme.fg("dim", s),
			},
		});
		return {
			render: (w) => panel.render(w),
			invalidate: () => panel.invalidate(),
			handleInput: (data) => {
				panel.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

export type PickFromList = (ctx: ExtensionCommandContext, title: string, items: SelectItem[], helpText: string) => Promise<string | null>;

/** Read-only result screen: a bordered, colored block dismissed by any keypress, so a human never has to squint at a raw JSON blob. */
async function showScreen(ctx: ExtensionCommandContext, title: string, data: unknown): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`${title}: ${JSON.stringify(data)}`, "info");
		return;
	}
	await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		let body = summarize(data, theme);
		const url = findFirstUrl(data);
		if (url) body += `\n${openLine(url, theme)}`;
		container.addChild(new Text(body, 1, 0));
		container.addChild(new Text(theme.fg("dim", "any key to continue"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: () => done(undefined),
		};
	});
}

export type ShowScreen = (ctx: ExtensionCommandContext, title: string, data: unknown) => Promise<void>;

async function runOperation(ctx: ExtensionCommandContext, client: PipesClient, title: string, operation: string, input: Record<string, unknown>, show: ShowScreen): Promise<void> {
	try {
		const result = await client.call(operation, input);
		await show(ctx, title, result);
	} catch (error) {
		ctx.ui.notify(`${title} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function pickBackend(ctx: ExtensionCommandContext, backends: BackendInfo[], pick: PickFromList, triggerableOnly: boolean): Promise<string | null> {
	const eligible = triggerableOnly ? backends.filter(isTriggerable) : backends;
	if (eligible.length === 0) {
		ctx.ui.notify(triggerableOnly ? "No configured backend supports triggering yet." : "No backends configured yet.", "info");
		return null;
	}
	const items: SelectItem[] = eligible.map((b) => ({ value: b.name, label: b.name, description: b.capabilities ?? "unconfigured" }));
	return pick(ctx, "Pick a backend", items, "\u2191\u2193 navigate \u2022 enter select \u2022 esc back");
}

async function triggerDirectFlow(ctx: ExtensionCommandContext, client: PipesClient, backends: BackendInfo[], pick: PickFromList, show: ShowScreen): Promise<void> {
	const backend = await pickBackend(ctx, backends, pick, true);
	if (!backend) return;

	const jobRef = await ctx.ui.input("Job ref (workflow file, job name, or job path)");
	if (!jobRef) return;

	const paramsText = await ctx.ui.input("Params (optional, key=value,key2=value2)");
	const params = paramsText ? parseParams(paramsText) : {};

	const confirmed = await ctx.ui.confirm(`Trigger ${backend}/${jobRef}?`, Object.keys(params).length > 0 ? `Params: ${JSON.stringify(params)}` : "No params.");
	if (!confirmed) return;

	await runOperation(ctx, client, "Trigger", "ci.trigger", { backend, jobRef, params }, show);
}

const RUN_ACTIONS: SelectItem[] = [
	{ value: "status", label: "Status", description: "Check the current verdict" },
	{ value: "detail", label: "Full detail view", description: "Scrollable status + log in one screen" },
	{ value: "trigger", label: "Trigger", description: "Start a new run" },
	{ value: "wait", label: "Wait", description: "Block until the run finishes" },
	{ value: "cancel", label: "Cancel", description: "Cancel a specific run (requires a run id)" },
	{ value: "log", label: "Log", description: "View the run's log" },
	{ value: ACTION_BACK, label: "Back" },
];

/**
 * Fetches ci.status and ci.log together and normalizes them into the flat
 * shape run-detail-view.ts renders -- ci.status's CIVerdict already nests a
 * FailureContext.log when the run failed, but manageRunFlow always fetches
 * its own top-level log too so the detail view works for a passing run as
 * well, not only a failed one.
 */
interface RawCIVerdict {
	check: RunDetailData["check"];
	failure?: RunDetailData["failure"] & { log?: { lines: string[]; totalLines: number; truncated?: boolean } };
}

async function fetchRunDetail(client: PipesClient, backend: string, jobRef: string, runId: string | undefined): Promise<RunDetailData> {
	const { verdict } = await client.call<{ verdict: RawCIVerdict }>("ci.status", { backend, jobRef, runId });
	let log: RunDetailData["log"];
	try {
		const logResult = await client.call<{ lines: string[]; totalLines: number; truncated?: boolean }>("ci.log", { backend, jobRef, runId });
		log = { lines: logResult.lines, totalLines: logResult.totalLines, truncated: logResult.truncated };
	} catch {
		// A run with no log yet (queued, or the backend has none) -- the view works fine without one.
		log = verdict.failure?.log;
	}
	return { check: verdict.check, failure: verdict.failure, log };
}

async function manageRunFlow(ctx: ExtensionCommandContext, client: PipesClient, backends: BackendInfo[], pick: PickFromList, show: ShowScreen): Promise<void> {
	const backend = await pickBackend(ctx, backends, pick, false);
	if (!backend) return;

	const jobRef = await ctx.ui.input("Job ref (workflow file, job name, or job path)");
	if (!jobRef) return;

	for (;;) {
		const runIdText = await ctx.ui.input("Run id (optional, blank = latest)");
		const runId = runIdText || undefined;

		const action = await pick(ctx, `${backend}/${jobRef}${runId ? ` #${runId}` : ""}`, RUN_ACTIONS, "\u2191\u2193 navigate \u2022 enter select \u2022 esc back");
		if (!action || action === ACTION_BACK) return;

		if (action === "status") {
			await runOperation(ctx, client, "Status", "ci.status", { backend, jobRef, runId }, show);
		} else if (action === "detail") {
			try {
				const detail = await fetchRunDetail(client, backend, jobRef, runId);
				await showRunDetailView(ctx, detail);
			} catch (error) {
				ctx.ui.notify(`Full detail view failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		} else if (action === "trigger") {
			const paramsText = await ctx.ui.input("Params (optional, key=value,key2=value2)");
			const params = paramsText ? parseParams(paramsText) : {};
			const confirmed = await ctx.ui.confirm(`Trigger ${backend}/${jobRef}?`, Object.keys(params).length > 0 ? `Params: ${JSON.stringify(params)}` : "No params.");
			if (confirmed) await runOperation(ctx, client, "Trigger", "ci.trigger", { backend, jobRef, params }, show);
		} else if (action === "wait") {
			await runOperation(ctx, client, "Wait", "ci.wait", { backend, jobRef, runId }, show);
		} else if (action === "cancel") {
			const cancelRunId = runId ?? (await ctx.ui.input("Run id to cancel (required)"));
			if (!cancelRunId) {
				ctx.ui.notify("Cancel needs an explicit run id \u2014 \"latest\" isn't safe to cancel blind.", "error");
				continue;
			}
			const confirmed = await ctx.ui.confirm(`Cancel ${backend}/${jobRef} #${cancelRunId}?`, "This cannot be undone.");
			if (confirmed) await runOperation(ctx, client, "Cancel", "ci.cancel", { backend, jobRef, runId: cancelRunId }, show);
		} else if (action === "log") {
			await runOperation(ctx, client, "Log", "ci.log", { backend, jobRef, runId }, show);
		}
	}
}

async function runPresetFlow(ctx: ExtensionCommandContext, client: PipesClient, preset: PresetInfo, show: ShowScreen): Promise<void> {
	// Optional per-invocation override, merged onto every step's own baked-in params server-side --
	// lets a preset whose values legitimately change between runs (a release image, a branch) stay
	// usable without needing to be re-bookmarked just to update one value each time.
	const overridesText = await ctx.ui.input("Override params for this run (optional, key=value,key2=value2)");
	const params = overridesText ? parseParams(overridesText) : undefined;

	const confirmed = await ctx.ui.confirm(`Trigger preset "${preset.name}"?`, params ? `${describePreset(preset)}\nOverrides: ${JSON.stringify(params)}` : describePreset(preset));
	if (!confirmed) return;
	await runOperation(ctx, client, `Trigger ${preset.name}`, "ci.trigger", params ? { pipeline: preset.name, params } : { pipeline: preset.name }, show);
}

/** One "jobName" or "jobName param=value,other=value" line at a time, until the human leaves the job name blank. */
async function collectPresetSteps(ctx: ExtensionCommandContext): Promise<Array<{ jobName: string; params?: Record<string, string> }>> {
	const steps: Array<{ jobName: string; params?: Record<string, string> }> = [];
	for (;;) {
		const jobName = await ctx.ui.input(steps.length === 0 ? "Step 1: job name" : `Step ${steps.length + 1}: job name (blank to finish)`);
		if (!jobName) break;
		const paramsText = await ctx.ui.input(`Step "${jobName}" params (optional, key=value,key2=value2)`);
		const params = paramsText ? parseParams(paramsText) : undefined;
		steps.push(params ? { jobName, params } : { jobName });
	}
	return steps;
}

async function addPresetFlow(ctx: ExtensionCommandContext, client: PipesClient, backends: BackendInfo[], existing: PresetInfo[], pick: PickFromList, show: ShowScreen): Promise<void> {
	const name = await ctx.ui.input("Preset name");
	if (!name) return;

	if (existing.some((p) => p.name === name)) {
		const overwrite = await ctx.ui.confirm(`"${name}" already exists`, "Overwrite it with a new definition?");
		if (!overwrite) return;
	}

	const backend = await pickBackend(ctx, backends, pick, true);
	if (!backend) return;

	const steps = await collectPresetSteps(ctx);
	if (steps.length === 0) {
		ctx.ui.notify("A preset needs at least one step.", "error");
		return;
	}

	const preset: PresetInfo = { name, backend, steps };
	const confirmed = await ctx.ui.confirm(`Save preset "${name}"?`, describePreset(preset));
	if (!confirmed) return;

	await runOperation(ctx, client, "Save preset", "ci.presets.set", { preset }, show);
}

async function managePresetsFlow(ctx: ExtensionCommandContext, client: PipesClient, backends: BackendInfo[], pick: PickFromList, show: ShowScreen): Promise<void> {
	for (;;) {
		const { presets } = await client.call<{ presets: PresetInfo[] }>("ci.presets.list", {});
		const items: SelectItem[] = [
			...presets.map((p) => ({ value: `${ACTION_VIEW_PRESET_PREFIX}${p.name}`, label: p.name, description: describePreset(p) })),
			{ value: ACTION_ADD_PRESET, label: "+ Add new preset" },
			{ value: ACTION_BACK, label: "Back" },
		];
		const selected = await pick(ctx, "Manage presets", items, "\u2191\u2193 navigate \u2022 enter select \u2022 esc back");
		if (!selected || selected === ACTION_BACK) return;

		if (selected === ACTION_ADD_PRESET) {
			await addPresetFlow(ctx, client, backends, presets, pick, show);
			continue;
		}

		const name = selected.slice(ACTION_VIEW_PRESET_PREFIX.length);
		const preset = presets.find((p) => p.name === name);
		if (!preset) continue;

		const items2: SelectItem[] = [
			{ value: "view", label: "View" },
			{ value: "remove", label: "Remove" },
			{ value: ACTION_BACK, label: "Back" },
		];
		const action = await pick(ctx, name, items2, "\u2191\u2193 navigate \u2022 enter select \u2022 esc back");
		if (action === "view") {
			await show(ctx, name, preset);
			ctx.ui.notify("To change a preset, remove it and add a new one with the same name.", "info");
		} else if (action === "remove") {
			const confirmed = await ctx.ui.confirm(`Remove preset "${name}"?`, "This cannot be undone.");
			if (confirmed) await runOperation(ctx, client, "Remove preset", "ci.presets.remove", { name }, show);
		}
	}
}

export async function runPipesCommand(ctx: ExtensionCommandContext, connect: () => Promise<PipesClient>, pick: PickFromList = pickFromList, show: ShowScreen = showScreen): Promise<void> {
	let client: PipesClient;
	try {
		client = await connect();
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}

	for (;;) {
		let backends: BackendInfo[];
		let presets: PresetInfo[];
		try {
			const help = await client.call<{ backends: BackendInfo[]; pipelines: string[] }>("ci.help", {});
			backends = help.backends;
			presets = (await client.call<{ presets: PresetInfo[] }>("ci.presets.list", {})).presets;
		} catch (error) {
			ctx.ui.notify(`Could not reach the Pipes daemon: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}

		const items: SelectItem[] = [
			...presets.map((p) => ({ value: `${ACTION_RUN_PRESET_PREFIX}${p.name}`, label: `\u25b6 ${p.name}`, description: describePreset(p) })),
			{ value: ACTION_TRIGGER_DIRECT, label: "Trigger a job directly", description: "Pick a backend and job ref manually" },
			{ value: ACTION_MANAGE_RUN, label: "Check status / manage a run", description: "Status, trigger, wait, cancel, or view a log" },
			{ value: ACTION_MANAGE_PRESETS, label: "Manage presets", description: `${presets.length} configured` },
		];
		const selected = await pick(ctx, "Pipes", items, "\u2191\u2193 navigate \u2022 enter select \u2022 esc close");
		if (!selected) return;

		if (selected === ACTION_TRIGGER_DIRECT) {
			await triggerDirectFlow(ctx, client, backends, pick, show);
		} else if (selected === ACTION_MANAGE_RUN) {
			await manageRunFlow(ctx, client, backends, pick, show);
		} else if (selected === ACTION_MANAGE_PRESETS) {
			await managePresetsFlow(ctx, client, backends, pick, show);
		} else if (selected.startsWith(ACTION_RUN_PRESET_PREFIX)) {
			const name = selected.slice(ACTION_RUN_PRESET_PREFIX.length);
			const preset = presets.find((p) => p.name === name);
			if (preset) await runPresetFlow(ctx, client, preset, show);
		}
	}
}

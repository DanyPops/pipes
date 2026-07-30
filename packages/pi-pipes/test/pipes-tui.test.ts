import { describe, expect, it } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describePreset, isTriggerable, parseParams, type PickFromList, runPipesCommand, type ShowScreen } from "../src/pipes-tui.ts";
import type { PipesClient } from "../src/daemon-client.ts";

describe("parseParams", () => {
	it("parses comma-separated key=value pairs", () => {
		expect(parseParams("env=prod,region=us-east-1")).toEqual({ env: "prod", region: "us-east-1" });
	});

	it("trims whitespace around keys, values, and segments", () => {
		expect(parseParams(" env = prod , region = us-east-1 ")).toEqual({ env: "prod", region: "us-east-1" });
	});

	it("returns {} for blank input", () => {
		expect(parseParams("")).toEqual({});
		expect(parseParams("   ")).toEqual({});
	});

	it("skips a segment with no '=' rather than throwing", () => {
		expect(parseParams("env=prod,garbage,region=us")).toEqual({ env: "prod", region: "us" });
	});

	it("skips a segment with an empty key", () => {
		expect(parseParams("=novalue,env=prod")).toEqual({ env: "prod" });
	});

	it("allows an empty value", () => {
		expect(parseParams("flag=")).toEqual({ flag: "" });
	});
});

describe("isTriggerable", () => {
	it("is true when capabilities includes trigger", () => {
		expect(isTriggerable({ name: "gh", type: "github", capabilities: "trigger history stages artifacts" })).toBe(true);
	});

	it("is false for an unconfigured or non-triggering backend", () => {
		expect(isTriggerable({ name: "gitlab", type: "gitlab", capabilities: "unconfigured" })).toBe(false);
		expect(isTriggerable({ name: "gh", type: "github" })).toBe(false);
	});
});

describe("describePreset", () => {
	it("summarizes backend and step names", () => {
		const text = describePreset({ name: "deploy", backend: "github", steps: [{ jobName: "build" }, { jobName: "release" }] });
		expect(text).toContain("github");
		expect(text).toContain("2 step(s)");
		expect(text).toContain("build");
		expect(text).toContain("release");
	});
});

// ── Interactive-flow harness, mirroring pi-enigma's own fakeCtx/scriptedPick pattern ──

function fakeCtx(overrides: { confirms?: boolean[]; inputs?: Array<string | undefined> } = {}): {
	ctx: ExtensionCommandContext;
	notifications: Array<{ text: string; level: string }>;
	inputPrompts: string[];
} {
	const notifications: Array<{ text: string; level: string }> = [];
	const inputPrompts: string[] = [];
	const inputQueue = [...(overrides.inputs ?? [])];
	const confirmQueue = [...(overrides.confirms ?? [])];
	const ctx = {
		mode: "tui",
		ui: {
			notify: (text: string, level: string) => {
				notifications.push({ text, level });
			},
			confirm: async () => (confirmQueue.length > 0 ? confirmQueue.shift()! : true),
			input: async (title: string) => {
				inputPrompts.push(title);
				return inputQueue.length > 0 ? inputQueue.shift() : undefined;
			},
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notifications, inputPrompts };
}

/** Scripted `pick`: returns each queued value in order, then null forever after (matches "esc back" on every further prompt). */
function scriptedPick(...values: Array<string | null>): PickFromList {
	const queue = [...values];
	return async () => (queue.length > 0 ? queue.shift()! : null);
}

/** Same as scriptedPick, but also appends every menu's item labels to `seen`, in call order. */
function scriptedPickCapturing(seen: string[][], ...values: Array<string | null>): PickFromList {
	const queue = [...values];
	return async (_ctx, _title, items) => {
		seen.push(items.map((item) => item.label));
		return queue.length > 0 ? queue.shift()! : null;
	};
}

/** Records every show() call instead of rendering a real TUI screen. */
function recordingShow(): { show: ShowScreen; calls: Array<{ title: string; data: unknown }> } {
	const calls: Array<{ title: string; data: unknown }> = [];
	const show: ShowScreen = async (_ctx, title, data) => {
		calls.push({ title, data });
	};
	return { show, calls };
}

function fakeClient(handlers: Record<string, (input: Record<string, unknown>) => unknown>): PipesClient & { calls: Array<{ op: string; input: unknown }> } {
	const calls: Array<{ op: string; input: unknown }> = [];
	return {
		calls,
		call: async <T>(operation: string, input: Record<string, unknown>): Promise<T> => {
			calls.push({ op: operation, input });
			const handler = handlers[operation];
			if (!handler) throw new Error(`unhandled operation in test fake: ${operation}`);
			return handler(input) as T;
		},
		health: async () => ({ ok: true, version: "test" }),
	};
}

const BACKENDS = [
	{ name: "github", type: "github", capabilities: "trigger history stages artifacts" },
	{ name: "gitlab", type: "gitlab", capabilities: "unconfigured" },
];

describe("runPipesCommand: connection failure", () => {
	it("notifies and exits cleanly when the daemon can't be reached, without ever prompting", async () => {
		const { ctx, notifications } = fakeCtx();
		const pick = scriptedPick();
		const connect = async () => {
			throw new Error("daemon not running");
		};

		await runPipesCommand(ctx, connect, pick);

		expect(notifications).toHaveLength(1);
		expect(notifications[0]?.level).toBe("error");
		expect(notifications[0]?.text).toContain("daemon not running");
	});
});

describe("runPipesCommand: trigger a job directly", () => {
	it("picks a triggerable backend, prompts jobRef and params, confirms, and shows the result", async () => {
		const { ctx } = fakeCtx({ inputs: ["ci.yml", "env=prod"], confirms: [true] });
		const { show, calls } = recordingShow();
		const client = fakeClient({
			"ci.help": () => ({ backends: BACKENDS, pipelines: [] }),
			"ci.presets.list": () => ({ presets: [] }),
			"ci.trigger": () => ({ result: { backend: "github", jobRef: "ci.yml", buildNumber: "1" } }),
		});
		const pick = scriptedPick("__pipes_trigger_direct__", "github");

		await runPipesCommand(ctx, async () => client, pick, show);

		const triggerCall = client.calls.find((c) => c.op === "ci.trigger");
		expect(triggerCall?.input).toEqual({ backend: "github", jobRef: "ci.yml", params: { env: "prod" } });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.title).toBe("Trigger");
	});

	it("only offers backends with the trigger capability", async () => {
		const { ctx } = fakeCtx();
		const client = fakeClient({
			"ci.help": () => ({ backends: BACKENDS, pipelines: [] }),
			"ci.presets.list": () => ({ presets: [] }),
		});
		let offeredBackendItems: string[] = [];
		let enteredMainMenu = false;
		const pick: PickFromList = async (_ctx, title, items) => {
			if (title === "Pipes" && !enteredMainMenu) {
				enteredMainMenu = true;
				return "__pipes_trigger_direct__";
			}
			if (title === "Pick a backend") offeredBackendItems = items.map((i) => i.value);
			return null; // cancel out of every further picker immediately
		};

		await runPipesCommand(ctx, async () => client, pick, recordingShow().show);

		expect(offeredBackendItems).toEqual(["github"]);
	});

	it("bails out without calling trigger when jobRef is left blank", async () => {
		const { ctx } = fakeCtx({ inputs: [undefined] });
		const client = fakeClient({
			"ci.help": () => ({ backends: BACKENDS, pipelines: [] }),
			"ci.presets.list": () => ({ presets: [] }),
		});
		const pick = scriptedPick("__pipes_trigger_direct__", "github");

		await runPipesCommand(ctx, async () => client, pick, recordingShow().show);

		expect(client.calls.some((c) => c.op === "ci.trigger")).toBe(false);
	});
});

describe("runPipesCommand: manage a run", () => {
	it("checks status for a backend/jobRef/runId then loops back to the action picker", async () => {
		const { ctx } = fakeCtx({ inputs: ["ci.yml", "42"] });
		const { show, calls } = recordingShow();
		const client = fakeClient({
			"ci.help": () => ({ backends: BACKENDS, pipelines: [] }),
			"ci.presets.list": () => ({ presets: [] }),
			"ci.status": (input) => ({ verdict: { check: { ...input, status: "success" } } }),
		});
		const pick = scriptedPick("__pipes_manage_run__", "github", "status", "__pipes_back__");

		await runPipesCommand(ctx, async () => client, pick, show);

		const statusCall = client.calls.find((c) => c.op === "ci.status");
		expect(statusCall?.input).toEqual({ backend: "github", jobRef: "ci.yml", runId: "42" });
		expect(calls[0]?.title).toBe("Status");
	});

	it("treats a blank run id as undefined (latest), not the literal string", async () => {
		const { ctx } = fakeCtx({ inputs: ["ci.yml", undefined] });
		const client = fakeClient({
			"ci.help": () => ({ backends: BACKENDS, pipelines: [] }),
			"ci.presets.list": () => ({ presets: [] }),
			"ci.status": () => ({ verdict: { check: { status: "success" } } }),
		});
		const pick = scriptedPick("__pipes_manage_run__", "github", "status", "__pipes_back__");

		await runPipesCommand(ctx, async () => client, pick, recordingShow().show);

		const statusCall = client.calls.find((c) => c.op === "ci.status");
		expect(statusCall?.input).toEqual({ backend: "github", jobRef: "ci.yml", runId: undefined });
	});

	it("refuses to cancel without an explicit run id, and re-prompts the action picker instead of calling cancel blind", async () => {
		const { ctx, notifications } = fakeCtx({ inputs: ["ci.yml", undefined, undefined] });
		const client = fakeClient({
			"ci.help": () => ({ backends: BACKENDS, pipelines: [] }),
			"ci.presets.list": () => ({ presets: [] }),
		});
		const pick = scriptedPick("__pipes_manage_run__", "github", "cancel", "__pipes_back__");

		await runPipesCommand(ctx, async () => client, pick, recordingShow().show);

		expect(client.calls.some((c) => c.op === "ci.cancel")).toBe(false);
		expect(notifications.some((n) => n.text.includes("explicit run id"))).toBe(true);
	});

	it("cancels a run once an explicit run id and confirmation are given", async () => {
		const { ctx } = fakeCtx({ inputs: ["ci.yml", "42"], confirms: [true] });
		const { show, calls } = recordingShow();
		const client = fakeClient({
			"ci.help": () => ({ backends: BACKENDS, pipelines: [] }),
			"ci.presets.list": () => ({ presets: [] }),
			"ci.cancel": () => ({ status: "cancelled", runId: "42" }),
		});
		const pick = scriptedPick("__pipes_manage_run__", "github", "cancel", "__pipes_back__");

		await runPipesCommand(ctx, async () => client, pick, show);

		const cancelCall = client.calls.find((c) => c.op === "ci.cancel");
		expect(cancelCall?.input).toEqual({ backend: "github", jobRef: "ci.yml", runId: "42" });
		expect(calls[0]?.title).toBe("Cancel");
	});

	it("skips the cancel call when the confirmation is declined", async () => {
		const { ctx } = fakeCtx({ inputs: ["ci.yml", "42"], confirms: [false] });
		const client = fakeClient({
			"ci.help": () => ({ backends: BACKENDS, pipelines: [] }),
			"ci.presets.list": () => ({ presets: [] }),
		});
		const pick = scriptedPick("__pipes_manage_run__", "github", "cancel", "__pipes_back__");

		await runPipesCommand(ctx, async () => client, pick, recordingShow().show);

		expect(client.calls.some((c) => c.op === "ci.cancel")).toBe(false);
	});
});

describe("runPipesCommand: presets", () => {
	it("triggers a preset by name after confirmation", async () => {
		const { ctx } = fakeCtx({ confirms: [true] });
		const { show, calls } = recordingShow();
		const preset = { name: "deploy", backend: "github", steps: [{ jobName: "build" }] };
		const client = fakeClient({
			"ci.help": () => ({ backends: BACKENDS, pipelines: ["deploy"] }),
			"ci.presets.list": () => ({ presets: [preset] }),
			"ci.trigger": () => ({ result: { backend: "github", jobRef: "build", buildNumber: "1" } }),
		});
		const pick = scriptedPick("run-preset:deploy");

		await runPipesCommand(ctx, async () => client, pick, show);

		const triggerCall = client.calls.find((c) => c.op === "ci.trigger");
		expect(triggerCall?.input).toEqual({ pipeline: "deploy" });
		expect(calls[0]?.title).toBe("Trigger deploy");
	});

	it("forwards an override params prompt as a per-invocation override onto the preset's own baked-in params", async () => {
		const { ctx } = fakeCtx({ inputs: ["ENV=prod,VERSION=4.20"], confirms: [true] });
		const { show, calls } = recordingShow();
		const preset = { name: "deploy", backend: "github", steps: [{ jobName: "build", params: { ENV: "stage" } }] };
		const client = fakeClient({
			"ci.help": () => ({ backends: BACKENDS, pipelines: ["deploy"] }),
			"ci.presets.list": () => ({ presets: [preset] }),
			"ci.trigger": () => ({ result: { backend: "github", jobRef: "build", buildNumber: "1" } }),
		});
		const pick = scriptedPick("run-preset:deploy");

		await runPipesCommand(ctx, async () => client, pick, show);

		const triggerCall = client.calls.find((c) => c.op === "ci.trigger");
		expect(triggerCall?.input).toEqual({ pipeline: "deploy", params: { ENV: "prod", VERSION: "4.20" } });
		expect(calls[0]?.title).toBe("Trigger deploy");
	});

	it("adds a new preset with one step and persists it via ci.presets.set", async () => {
		const { ctx } = fakeCtx({ inputs: ["deploy", "build", undefined], confirms: [true] });
		const { show, calls } = recordingShow();
		const client = fakeClient({
			"ci.help": () => ({ backends: BACKENDS, pipelines: [] }),
			"ci.presets.list": () => ({ presets: [] }),
			"ci.presets.set": (input) => ({ preset: input.preset }),
		});
		const pick = scriptedPick("__pipes_manage_presets__", "__pipes_add_preset__", "github", "__pipes_back__");

		await runPipesCommand(ctx, async () => client, pick, show);

		const setCall = client.calls.find((c) => c.op === "ci.presets.set");
		expect(setCall?.input).toEqual({ preset: { name: "deploy", backend: "github", steps: [{ jobName: "build" }] } });
		expect(calls[0]?.title).toBe("Save preset");
	});

	it("collects multiple steps until the job name is left blank", async () => {
		const { ctx } = fakeCtx({ inputs: ["deploy", "build", undefined, "release", "env=prod", undefined], confirms: [true] });
		const client = fakeClient({
			"ci.help": () => ({ backends: BACKENDS, pipelines: [] }),
			"ci.presets.list": () => ({ presets: [] }),
			"ci.presets.set": (input) => ({ preset: input.preset }),
		});
		const pick = scriptedPick("__pipes_manage_presets__", "__pipes_add_preset__", "github", "__pipes_back__");

		await runPipesCommand(ctx, async () => client, pick, recordingShow().show);

		const setCall = client.calls.find((c) => c.op === "ci.presets.set");
		expect(setCall?.input).toEqual({
			preset: { name: "deploy", backend: "github", steps: [{ jobName: "build" }, { jobName: "release", params: { env: "prod" } }] },
		});
	});

	it("refuses to save a preset with zero steps", async () => {
		const { ctx, notifications } = fakeCtx({ inputs: ["deploy", undefined] });
		const client = fakeClient({
			"ci.help": () => ({ backends: BACKENDS, pipelines: [] }),
			"ci.presets.list": () => ({ presets: [] }),
		});
		const pick = scriptedPick("__pipes_manage_presets__", "__pipes_add_preset__", "github", "__pipes_back__");

		await runPipesCommand(ctx, async () => client, pick, recordingShow().show);

		expect(client.calls.some((c) => c.op === "ci.presets.set")).toBe(false);
		expect(notifications.some((n) => n.text.includes("at least one step"))).toBe(true);
	});

	it("removes an existing preset after confirmation", async () => {
		const { ctx } = fakeCtx({ confirms: [true] });
		const { show, calls } = recordingShow();
		const preset = { name: "deploy", backend: "github", steps: [{ jobName: "build" }] };
		const client = fakeClient({
			"ci.help": () => ({ backends: BACKENDS, pipelines: ["deploy"] }),
			"ci.presets.list": () => ({ presets: [preset] }),
			"ci.presets.remove": () => ({ removed: true }),
		});
		const pick = scriptedPick("__pipes_manage_presets__", "view-preset:deploy", "remove", "__pipes_back__");

		await runPipesCommand(ctx, async () => client, pick, show);

		const removeCall = client.calls.find((c) => c.op === "ci.presets.remove");
		expect(removeCall?.input).toEqual({ name: "deploy" });
		expect(calls[0]?.title).toBe("Remove preset");
	});

	it("shows a preset's full definition on 'view' without calling remove", async () => {
		const { ctx } = fakeCtx();
		const { show, calls } = recordingShow();
		const preset = { name: "deploy", backend: "github", steps: [{ jobName: "build" }] };
		const client = fakeClient({
			"ci.help": () => ({ backends: BACKENDS, pipelines: ["deploy"] }),
			"ci.presets.list": () => ({ presets: [preset] }),
		});
		const pick = scriptedPick("__pipes_manage_presets__", "view-preset:deploy", "view", "__pipes_back__", "__pipes_back__");

		await runPipesCommand(ctx, async () => client, pick, show);

		expect(client.calls.some((c) => c.op === "ci.presets.remove")).toBe(false);
		expect(calls[0]?.title).toBe("deploy");
		expect(calls[0]?.data).toEqual(preset);
	});
});

// Secrets moved out of /pipes' own menu and into the shared /secrets namespace --
// see index.test.ts for the registerSharedSecretsCommand wiring, and vehicle-client-pi's
// own secrets-tui.test.ts for the generic command's behavior.

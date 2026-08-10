/**
 * Answers a real question: does a ci_subscribe'd job's status transition ever reach the *agent*
 * (a message the LLM sees, or something that wakes it up on its own), or only the human-facing
 * "Jobs" widget? Uses @danypops/pi-extension-harness (packages/pi-extension-harness in
 * ~/Projects/pi-integral) -- an in-process ExtensionAPI/ExtensionContext stub, no real
 * AgentSession, LLM, daemon, or timer. Deterministic: every "poll tick" here is a direct
 * h.emit("session_start", ...) call driven by a hand-controlled fake connector, never a real
 * setInterval or network call.
 *
 * Pi's own extension API does have the mechanism that *would* be needed for this --
 * pi.sendUserMessage()/pi.sendMessage({..., triggerTurn: true}) "always triggers a turn" (see
 * docs/extensions.md's own wording) even when the agent is idle. pipesExtension never calls
 * either. This file is the reproducible proof of that gap, not a spec for what should replace it
 * -- see the "not yet wired" assertions below and the conversation's own written answer for the
 * fuller picture (the daemon does have a push channel, packages/pipes' PushChannel.publish("ci",
 * ...) in process/daemon.ts, but pi-pipes' own client -- jobs-client.ts -- never subscribes to
 * it; JobsOverlay is poll-only).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pipesExtension from "../src/index.ts";
import { resetJobsClientConnectorForTests, setJobsClientConnectorForTests } from "../src/jobs-client.ts";

function subscribedRun(status: string) {
	return {
		backend: "jenkins-auto",
		jobRef: "ocp-baremetal-ipi-deployment",
		runId: "40531",
		status,
		result: status === "success" ? "SUCCESS" : "",
		url: "https://jenkins-csb-kniqe-auto.dno.corp.redhat.com/job/ocp-baremetal-ipi-deployment/40531/",
		startedAt: new Date(0),
		fetchedAt: new Date(0),
		watched: status !== "success",
	};
}

/** factory(api) is called with exactly one argument by the harness -- PiPipesDeps.registerVehicle
 * (the second, test-injection argument) has no seam through createExtensionHarness itself, so this
 * wraps pipesExtension the same way any ExtensionFactory caller would partially apply extra config.
 * Overriding it to a no-op is what keeps this test from ever touching a real pipes daemon handle
 * file on this machine -- the actual "no side effects" guarantee the harness alone doesn't give
 * for free, since registerPipesVehicle would otherwise really run during boot(). */
function harnessFactory(): (pi: ExtensionAPI) => Promise<void> {
	return (pi: ExtensionAPI) => pipesExtension(pi, { registerVehicle: async () => undefined });
}

describe("ci_subscribe's status transitions and the agent -- deterministic, mocked, no real daemon/timer/side effects", () => {
	afterEach(resetJobsClientConnectorForTests);

	it("a subscribed job finishing (running -> success) updates the widget but sends the agent no message at all", async () => {
		let currentStatus = "running";
		setJobsClientConnectorForTests(
			() =>
				({
					async call() {
						// Once terminal, the real ci.subscribed (RunPool.watchedRuns()) drops the run too --
						// mirrored here as an empty result once "success", matching real server behavior.
						return { runs: currentStatus === "success" ? [] : [subscribedRun(currentStatus)] };
					},
					// biome-ignore lint/suspicious/noExplicitAny: minimal test double, not the real PipesClient shape
				}) as any,
		);

		const h = createExtensionHarness(harnessFactory());
		// The stub ctx starts hasUI:false (a headless/RPC session) -- give it a UI-carrying ctx
		// before booting, same shape a real interactive `pi` session has, since the jobs widget
		// only ever wires up when ctx.hasUI is true (see index.ts).
		let registeredFactory: unknown;
		Object.assign(h.ctx, {
			hasUI: true,
			ui: { ...h.ctx.ui, setWidget: (_key: string, factory: unknown) => (registeredFactory = factory) },
		});

		await h.boot(); // fires session_start -- first refresh() sees the "running" job, widget registers

		expect(registeredFactory).toBeDefined();
		expect(h.userMessages).toEqual([]); // nothing sent to the agent just from subscribing/observing

		// Simulate the daemon's background sync loop having moved the job to "success" between polls
		// -- fires the exact same session_start handler (and therefore the exact same
		// JobsOverlay.refresh() call) the widget's own real setInterval poll tick would eventually
		// fire, but driven deterministically here instead of waiting on a real timer.
		currentStatus = "success";
		await h.emit("session_start", {});

		expect(h.userMessages).toEqual([]); // still nothing -- a status transition reaches only the widget
		expect(h.notifications).toEqual([]); // not even a ui.notify()
		expect(h.appendedEntries).toEqual([]); // not even a durable pi.appendEntry()
	});

	it("Pi's own extension API does expose the mechanism that would be needed here (sendUserMessage) -- pipesExtension just never calls it", async () => {
		setJobsClientConnectorForTests(
			() =>
				({
					async call() {
						return { runs: [] };
					},
					// biome-ignore lint/suspicious/noExplicitAny: minimal test double, not the real PipesClient shape
				}) as any,
		);
		const h = createExtensionHarness(harnessFactory());
		await h.boot();

		// docs/extensions.md: pi.sendUserMessage() "Always triggers a turn" -- even while idle --
		// which is exactly the capability a background poll would need to wake the agent up on a
		// subscribed job's completion. It's a real, callable function on this session's api;
		// pipesExtension's own jobs-overlay.ts simply never reaches for it (h.userMessages is empty
		// throughout the previous test, confirming that by omission rather than assertion alone).
		expect(typeof h.api.sendUserMessage).toBe("function");
	});
});

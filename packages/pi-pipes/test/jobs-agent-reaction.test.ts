/**
 * Answers a real question raised against a live session: does a ci_subscribe'd job's status
 * transition ever reach the *agent* (a message the LLM sees, or something that wakes it up on its
 * own), or only the human-facing "Jobs" widget?
 *
 * Uses @danypops/pi-extension-harness (packages/pi-extension-harness in ~/Projects/pi-integral) --
 * an in-process ExtensionAPI/ExtensionContext stub, no real AgentSession, LLM, daemon, or timer.
 * Deterministic: every "poll tick" here is a direct h.emit("session_start", ...) call driven by a
 * hand-controlled fake connector, never a real setInterval or network call.
 *
 * This started out proving a gap (pi-pipes only ever updated the widget). jobs-overlay.ts and
 * job-ticker.ts now wire a subscribed job's terminal transition -- and, on a slower throttle, a
 * "still in flight" reminder -- through to pi.sendMessage(..., {deliverAs: "followUp"})
 * (@danypops/vehicle-client-pi's createAgentNotifier/reportAgentPollTick), a custom message that
 * participates in LLM context but -- unlike pi.sendUserMessage(), which always triggers a turn --
 * only forces an immediate turn if triggerTurn is explicitly set true, which this never does. This
 * file is now the reproducible proof that the wiring actually reaches the agent (via h.sentMessages,
 * the harness's own recording of pi.sendMessage() calls -- a distinct channel from h.userMessages),
 * not just the widget -- see job-ticker.test.ts and jobs-overlay.test.ts for the unit-level coverage
 * of the decision logic itself.
 *
 * Separately (not covered here): packages/pipes' daemon does already publish a push channel for
 * this (PushChannel.publish("ci", ...) in process/daemon.ts's pool-sync wiring), but pi-pipes' own
 * jobs-client.ts never subscribes to it -- JobsOverlay is still poll-only (JOBS_WIDGET_POLL_INTERVAL_MS).
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

	it("a subscribed job finishing (running -> success) both updates the widget and sends the agent a real user message", async () => {
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
		expect(h.sentMessages).toEqual([]); // nothing sent to the agent just from subscribing/observing -- no baseline transition yet

		// Simulate the daemon's background sync loop having moved the job to "success" between polls
		// -- fires the exact same session_start handler (and therefore the exact same
		// JobsOverlay.refresh() call) the widget's own real setInterval poll tick would eventually
		// fire, but driven deterministically here instead of waiting on a real timer.
		currentStatus = "success";
		await h.emit("session_start", {});

		expect(h.sentMessages).toHaveLength(1);
		expect(h.sentMessages[0]?.message.content).toContain("jenkins-auto/ocp-baremetal-ipi-deployment/40531");
		expect(String(h.sentMessages[0]?.message.content).toLowerCase()).toContain("finished");
		// vehicle-client-pi's own createAgentNotifier deliberately sends display: false -- convertToLlm()
		// folds a "custom" message into the agent's own context regardless of display; display only
		// governs whether the human's TUI also renders a visible chat bubble, which a background nudge
		// should never force on every reminder/vanish tick (see agent-poll-ticker.ts's own doc comment).
		expect(h.sentMessages[0]?.message.display).toBe(false);
		expect(h.sentMessages[0]?.options).toEqual({ deliverAs: "followUp" });
		expect(h.userMessages).toEqual([]); // never the always-turn-triggering sendUserMessage channel
	});

	it("does not nudge the agent again on the very next tick once the finish has already been reported", async () => {
		let runs: unknown[] = [subscribedRun("running")];
		setJobsClientConnectorForTests(
			() =>
				({
					async call() {
						return { runs };
					},
					// biome-ignore lint/suspicious/noExplicitAny: minimal test double, not the real PipesClient shape
				}) as any,
		);

		const h = createExtensionHarness(harnessFactory());
		Object.assign(h.ctx, { hasUI: true, ui: { ...h.ctx.ui, setWidget: () => {} } });
		await h.boot();

		runs = [];
		await h.emit("session_start", {});
		expect(h.sentMessages).toHaveLength(1);

		await h.emit("session_start", {}); // still empty -- nothing new vanished, no reminder due yet
		expect(h.sentMessages).toHaveLength(1);
	});
});

/**
 * Multiple concurrent Pi sessions, each subscribing to its own unique job, against the one shared
 * (mocked) daemon connector every real `pipes serve` process actually is. This is the deterministic,
 * harness-driven proof that session A's own ticker never notifies session A's agent about session
 * B's job (and vice versa) -- originally written and confirmed RED against the real pre-fix bug
 * (ci.subscribed had no session-scoping input at all, Record<string, never>, and returned every
 * watched run globally to any caller), now GREEN against the real fix: ci.subscribed's own
 * subscriberId filter (packages/pipes' RunPool.watchedRunsWithProjectLabels/rpc/service.ts) plus
 * JobsOverlay/index.ts threading each session's own real id into every fetch.
 *
 * Uses @danypops/pi-extension-harness (~/Projects/pi-integral). Two independent harness instances,
 * each running the real pipesExtension, share one process-global mocked connector (module-level
 * state in jobs-client.ts) -- exactly mirroring two real `pi` sessions pointed at the same real
 * pipes daemon. Session identity is set by directly overriding each harness's own `ctx.sessionManager`
 * (the ctx proxy is get-trap-only, so a plain property write passes straight through to the
 * underlying stub -- see extension-harness.ts -- no pi-integral change needed for this).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pipesExtension from "../src/index.ts";
import { resetJobsClientConnectorForTests, setJobsClientConnectorForTests } from "../src/jobs-client.ts";

interface FakeRun {
	backend: string;
	jobRef: string;
	runId: string;
	status: string;
	subscriberId: string;
}

function toWireRun(run: FakeRun) {
	return {
		backend: run.backend,
		jobRef: run.jobRef,
		runId: run.runId,
		status: run.status,
		result: run.status === "success" ? "SUCCESS" : "",
		url: `https://ci.example/${run.jobRef}/${run.runId}`,
		startedAt: new Date(0),
		fetchedAt: new Date(0),
		watched: run.status !== "success",
	};
}

function harnessFactory(): (pi: ExtensionAPI) => Promise<void> {
	return (pi: ExtensionAPI) => pipesExtension(pi, { registerVehicle: async () => undefined, resolveVehicleTarget: () => undefined });
}

/** Creates one harness pre-configured as a real interactive session: a UI-carrying ctx (the Jobs
 * widget only wires up when ctx.hasUI is true) plus a distinct session id/cwd, mirroring what a
 * real, separate `pi` process for a different project would report. */
async function createSessionHarness(sessionId: string, cwd: string) {
	const h = createExtensionHarness(harnessFactory(), { cwd });
	Object.assign(h.ctx, {
		hasUI: true,
		ui: { ...h.ctx.ui, setWidget: () => {} },
		sessionManager: { ...h.ctx.sessionManager, getSessionId: () => sessionId },
	});
	await h.boot(); // fires session_start -- JobsOverlay is constructed here, capturing this exact sessionId
	return h;
}

describe("multiple Pi sessions, each with its own subscribed job, against one shared daemon connector", () => {
	afterEach(resetJobsClientConnectorForTests);

	it("delivers a job's vanish/finish notification only to the session that actually subscribed to it, never to another concurrently-running session", async () => {
		const runs: FakeRun[] = [
			{ backend: "jenkins-auto", jobRef: "deploy-a", runId: "1", status: "running", subscriberId: "session-a" },
			{ backend: "danypops-github", jobRef: "build-b", runId: "2", status: "running", subscriberId: "session-b" },
		];
		// Mirrors the real (now-fixed) daemon: ci.subscribed honors an explicit subscriberId filter,
		// scoping the result to only that caller's own subscribed jobs (see packages/pipes' own
		// RunPool.watchedRunsWithProjectLabels / rpc/service.ts).
		setJobsClientConnectorForTests(
			() =>
				({
					async call(operation: string, input: { subscriberId?: string; runId?: string }) {
						if (operation === "ci.status") {
							const run = runs.find((candidate) => candidate.runId === input.runId);
							return { verdict: { check: { status: run?.status ?? "failure" } } };
						}
						const live = runs.filter((r) => r.status !== "success");
						const scoped = input.subscriberId === undefined ? live : live.filter((r) => r.subscriberId === input.subscriberId);
						return { runs: scoped.map(toWireRun) };
					},
					// biome-ignore lint/suspicious/noExplicitAny: minimal test double, not the real PipesClient shape
				}) as any,
		);

		const sessionA = await createSessionHarness("session-a", "/projects/a");
		const sessionB = await createSessionHarness("session-b", "/projects/b");

		// Baseline: both sessions observe both jobs (the shared, unscoped connector), but nothing
		// has transitioned yet, so neither agent has been notified of anything.
		expect(sessionA.sentMessages).toEqual([]);
		expect(sessionB.sentMessages).toEqual([]);

		// Only session A's own job (deploy-a) finishes.
		runs[0]!.status = "success";
		await sessionA.emit("session_start", {});
		await sessionB.emit("session_start", {});

		// Fixed behavior: only the session that actually subscribed to deploy-a is told about it
		// finishing -- ci.subscribed now honors subscriberId (see packages/pipes' own
		// RunPool.watchedRunsWithProjectLabels), and JobsOverlay passes this exact session's own real
		// id on every fetch (see index.ts).
		expect(sessionA.sentMessages.some((m) => String(m.message.content).includes("deploy-a"))).toBe(true);
		expect(sessionB.sentMessages.some((m) => String(m.message.content).includes("deploy-a"))).toBe(false);
	});
});

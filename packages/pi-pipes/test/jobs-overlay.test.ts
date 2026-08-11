import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { resetJobsClientConnectorForTests, setJobsClientConnectorForTests } from "../src/jobs-client.ts";
import { JobsOverlay } from "../src/jobs-overlay.ts";

function fakeClient(runs: unknown[]) {
	return {
		async call() {
			return { runs };
		},
		// biome-ignore lint/suspicious/noExplicitAny: minimal test double, not the real PipesClient shape
	} as any;
}

function subscribedRun(overrides: Record<string, unknown> = {}) {
	return {
		backend: "jenkins-auto",
		jobRef: "ocp-baremetal-ipi-deployment",
		runId: "40531",
		status: "running",
		result: "",
		url: "",
		startedAt: new Date(0),
		fetchedAt: new Date(0),
		watched: true,
		...overrides,
	};
}

describe("JobsOverlay", () => {
	afterEach(resetJobsClientConnectorForTests);

	it("registers the widget once refresh() finds at least one subscribed job", async () => {
		setJobsClientConnectorForTests(() => fakeClient([subscribedRun()]));
		let registeredKey: string | undefined;
		const uiCtx = {
			setWidget: (key: string, factory: unknown) => {
				if (factory !== undefined) registeredKey = key;
			},
		} as unknown as ExtensionUIContext;

		const overlay = new JobsOverlay();
		overlay.setUI(uiCtx);
		await overlay.refresh();

		expect(registeredKey).toBeDefined();
	});

	it("hides (unregisters) the widget once refresh() finds nothing subscribed", async () => {
		setJobsClientConnectorForTests(() => fakeClient([subscribedRun()]));
		const setWidgetCalls: Array<unknown> = [];
		const uiCtx = { setWidget: (_key: string, factory: unknown) => setWidgetCalls.push(factory) } as unknown as ExtensionUIContext;

		const overlay = new JobsOverlay();
		overlay.setUI(uiCtx);
		await overlay.refresh();
		expect(setWidgetCalls.at(-1)).toBeDefined();

		setJobsClientConnectorForTests(() => fakeClient([]));
		await overlay.refresh();
		expect(setWidgetCalls.at(-1)).toBeUndefined();
	});

	it("never throws, even when the daemon is unreachable (connector throws) or rendering itself fails", async () => {
		setJobsClientConnectorForTests(() => {
			throw new Error("Pipes daemon is not running; run `pipes serve`.");
		});
		const overlay = new JobsOverlay();
		overlay.setUI({} as ExtensionUIContext);
		(overlay as unknown as { render: () => void }).render = () => {
			throw new Error("boom");
		};

		await expect(overlay.refresh()).resolves.toBeUndefined();
	});

	it("does nothing (no throw) when refresh() is called before setUI()", async () => {
		setJobsClientConnectorForTests(() => fakeClient([subscribedRun()]));
		const overlay = new JobsOverlay();
		await expect(overlay.refresh()).resolves.toBeUndefined();
	});

	it("startPolling/stopPolling/dispose manage a bounded fallback poll, same as pi-papyrus's TaskOverlay/NoteOverlay", async () => {
		let calls = 0;
		setJobsClientConnectorForTests(
			() =>
				({
					async call() {
						calls += 1;
						return { runs: [] };
					},
					// biome-ignore lint/suspicious/noExplicitAny: minimal test double, not the real PipesClient shape
				}) as any,
		);
		const overlay = new JobsOverlay();
		overlay.setUI({ setWidget: () => {} } as unknown as ExtensionUIContext);

		overlay.startPolling(5);
		await new Promise((resolve) => setTimeout(resolve, 25));
		overlay.stopPolling();
		const callsAfterStop = calls;
		expect(callsAfterStop).toBeGreaterThan(0);

		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(calls).toBe(callsAfterStop); // stopped -- no further ticks

		overlay.dispose();
	});

	it("dispose() unregisters the widget and stops polling", async () => {
		setJobsClientConnectorForTests(() => fakeClient([subscribedRun()]));
		const setWidgetCalls: Array<unknown> = [];
		const uiCtx = { setWidget: (_key: string, factory: unknown) => setWidgetCalls.push(factory) } as unknown as ExtensionUIContext;
		const overlay = new JobsOverlay();
		overlay.setUI(uiCtx);
		await overlay.refresh();
		expect(setWidgetCalls.at(-1)).toBeDefined();

		overlay.dispose();
		expect(setWidgetCalls.at(-1)).toBeUndefined();
	});

	describe("notifying the agent", () => {
		function fakeNotifier() {
			const calls: Array<{ content: string; options?: { deliverAs?: "steer" | "followUp" } }> = [];
			return {
				calls,
				sendUserMessage: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => calls.push({ content, options }),
			};
		}

		it("never calls the notifier on the very first refresh -- no baseline transition yet", async () => {
			setJobsClientConnectorForTests(() => fakeClient([subscribedRun()]));
			const notifier = fakeNotifier();
			const overlay = new JobsOverlay("blocks", notifier);
			overlay.setUI({ setWidget: () => {} } as unknown as ExtensionUIContext);

			await overlay.refresh();

			expect(notifier.calls).toEqual([]);
		});

		it("notifies once a previously-subscribed job disappears (finished) between refreshes", async () => {
			setJobsClientConnectorForTests(() => fakeClient([subscribedRun()]));
			const notifier = fakeNotifier();
			const overlay = new JobsOverlay("blocks", notifier);
			overlay.setUI({ setWidget: () => {} } as unknown as ExtensionUIContext);
			await overlay.refresh();

			setJobsClientConnectorForTests(() => fakeClient([]));
			await overlay.refresh();

			expect(notifier.calls).toHaveLength(1);
			expect(notifier.calls[0]?.content).toContain("jenkins-auto/ocp-baremetal-ipi-deployment/40531");
			expect(notifier.calls[0]?.options).toEqual({ deliverAs: "followUp" }); // reportAgentPollTick's own default, since createAgentNotifier now forwards to the gentler pi.sendMessage()
		});

		it("does not treat a failed fetch as every job having vanished -- ticker state is untouched by a fetch error", async () => {
			setJobsClientConnectorForTests(() => fakeClient([subscribedRun()]));
			const notifier = fakeNotifier();
			const overlay = new JobsOverlay("blocks", notifier);
			overlay.setUI({ setWidget: () => {} } as unknown as ExtensionUIContext);
			await overlay.refresh(); // baseline: tracking the job

			setJobsClientConnectorForTests(() => {
				throw new Error("Pipes daemon is not running; run `pipes serve`.");
			});
			await overlay.refresh(); // transient daemon hiccup -- must not read as a vanish

			expect(notifier.calls).toEqual([]);

			setJobsClientConnectorForTests(() => fakeClient([])); // now genuinely gone
			await overlay.refresh();

			expect(notifier.calls).toHaveLength(1); // exactly once, not lost and not duplicated
		});

		it("never throws when no notifier is configured (default construction, matches every other test in this file)", async () => {
			setJobsClientConnectorForTests(() => fakeClient([subscribedRun()]));
			const overlay = new JobsOverlay();
			overlay.setUI({ setWidget: () => {} } as unknown as ExtensionUIContext);
			await overlay.refresh();
			setJobsClientConnectorForTests(() => fakeClient([]));
			await expect(overlay.refresh()).resolves.toBeUndefined();
		});

		it("a notifier that itself throws never crashes the widget", async () => {
			setJobsClientConnectorForTests(() => fakeClient([subscribedRun()]));
			const overlay = new JobsOverlay("blocks", {
				sendUserMessage: () => {
					throw new Error("session is mid-shutdown");
				},
			});
			overlay.setUI({ setWidget: () => {} } as unknown as ExtensionUIContext);
			await overlay.refresh();
			setJobsClientConnectorForTests(() => fakeClient([]));
			await expect(overlay.refresh()).resolves.toBeUndefined();
		});

		it("does not notify a job vanishing while a real turn is still blocking (isIdle() false) -- the isIdle predicate is threaded all the way through to reportAgentPollTick", async () => {
			setJobsClientConnectorForTests(() => fakeClient([subscribedRun()]));
			const notifier = fakeNotifier();
			let idle = true;
			const overlay = new JobsOverlay("blocks", notifier, undefined, undefined, () => idle);
			overlay.setUI({ setWidget: () => {} } as unknown as ExtensionUIContext);
			await overlay.refresh(); // baseline, while idle

			idle = false; // a tool call is now executing -- the turn is blocking
			setJobsClientConnectorForTests(() => fakeClient([])); // the job died mid-turn
			await overlay.refresh();

			expect(notifier.calls).toEqual([]); // must stay silent: never observed while idle

			idle = true; // turn ends, agent goes idle again
			await overlay.refresh(); // the diff resumes cleanly and reports the vanish fresh

			expect(notifier.calls).toHaveLength(1);
			expect(notifier.calls[0]?.content).toContain("jenkins-auto/ocp-baremetal-ipi-deployment/40531");
		});

		it("still notifies normally when no isIdle predicate is given at all -- backward compatible with every other test in this file", async () => {
			setJobsClientConnectorForTests(() => fakeClient([subscribedRun()]));
			const notifier = fakeNotifier();
			const overlay = new JobsOverlay("blocks", notifier);
			overlay.setUI({ setWidget: () => {} } as unknown as ExtensionUIContext);
			await overlay.refresh();

			setJobsClientConnectorForTests(() => fakeClient([]));
			await overlay.refresh();

			expect(notifier.calls).toHaveLength(1);
		});
	});
});

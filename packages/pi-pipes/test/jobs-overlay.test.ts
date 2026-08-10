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
});

/**
 * Loads this extension the same way Pi's real Bun binary loads it -- via jiti -- rather than a
 * plain Bun import(), and boots it through a real ExtensionAPI stub (createExtensionHarness) to
 * check actual behavior, not just "does importing this throw". Mirrors pi-tickets' own
 * jiti-load.test.ts (see that file's own doc comment for the class of regression this catches:
 * jiti can behave differently from a native import in real, previously hit ways).
 *
 * The Jobs-widget test below additionally closes a real, previously shipped gap that a plain
 * mocked-Date unit test cannot: AuthenticatedRpcClient.call() is response.json() with no reviver,
 * so RunSnapshot's own `startedAt: Date` type is a lie once it crosses the real HTTP transport --
 * it actually arrives as a plain ISO string. The 0.18.7 regression (every subscribed row silently
 * disappearing) shipped past jobs-client.test.ts and jobs-widget.test.ts because both mocked
 * `client.call()` with a real Date instance, never exercising the JSON boundary that lies about
 * the type. This test mocks at the correct boundary (JSON.parse(JSON.stringify(...)), the same
 * lossy round trip response.json() performs) and drives the real production code path --
 * pipesExtension's own session_start handler, JobsOverlay.refresh(), and the real
 * renderJobsWidgetLines -- instead of calling jobs-client.ts/jobs-widget.ts directly.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createExtensionHarness, loadExtensionViaJiti } from "@danypops/pi-extension-harness";
import { verifyLoadableUnderPi } from "@danypops/vehicle-client-pi/pi-load-harness";
import type { Theme } from "@earendil-works/pi-coding-agent";
import pipesExtension from "../src/index.ts";
import { resetJobsClientConnectorForTests, setJobsClientConnectorForTests } from "../src/jobs-client.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = join(__dirname, "../src/index.ts");

describe("pi-pipes loaded under every Pi extension load path", () => {
	it("loads without throwing via native ESM, jiti tryNative:false, and jiti tryNative:true", async () => {
		const results = await verifyLoadableUnderPi(EXTENSION_PATH);
		for (const result of results) {
			expect(result.ok, `${result.path}: ${result.error ?? ""}`).toBe(true);
		}
	});
});

describe("pi-pipes loaded via the production jiti path", () => {
	it("registers the /pipes and /secrets commands", async () => {
		const { __resetSecretsRegistryForTests } = await import("@danypops/vehicle-client-pi/secrets-registry");
		__resetSecretsRegistryForTests();

		const factory = await loadExtensionViaJiti(EXTENSION_PATH);
		const h = createExtensionHarness(factory);
		await h.boot();
		try {
			expect(h.commands).toEqual(["pipes", "secrets"]);
		} finally {
			await h.shutdown();
		}
	});
});

describe("pi-pipes Jobs widget end-to-end against the real (JSON-serialized) wire shape", () => {
	afterEach(resetJobsClientConnectorForTests);

	it("renders a subscribed job's runtime without throwing when ci.subscribed returns a plain ISO string for startedAt, exactly like the real un-revived JSON transport does", async () => {
		setJobsClientConnectorForTests(
			() =>
				({
					async call() {
						const raw = {
							runs: [
								{
									backend: "jenkins-auto",
									jobRef: "ocp-far-edge-vran-deployment",
									runId: "9253",
									status: "running",
									result: "",
									url: "https://jenkins.example/9253",
									startedAt: new Date("2026-08-24T14:07:18.795Z"),
									fetchedAt: new Date("2026-08-24T14:07:18.795Z"),
									watched: true,
								},
							],
						};
						// The real transport's own lossy boundary: AuthenticatedRpcClient.call() is
						// response.json() with no reviver. Round-tripping through JSON here (rather than
						// handing back `raw` -- a real Date instance -- directly) is what makes this test
						// fail red against the 0.18.7 regression and green against the 0.18.8 fix.
						return JSON.parse(JSON.stringify(raw));
					},
					// biome-ignore lint/suspicious/noExplicitAny: minimal test double, not the real PipesClient shape
				}) as any,
		);

		let capturedFactory: ((tui: unknown, theme: Theme) => { render: (width: number) => string[] }) | undefined;
		const h = createExtensionHarness((pi) => pipesExtension(pi, { registerVehicle: async () => undefined }));
		Object.assign(h.ctx, {
			hasUI: true,
			ui: {
				...h.ctx.ui,
				setWidget: (_key: string, factory: typeof capturedFactory) => {
					capturedFactory = factory;
				},
			},
		});

		try {
			await h.boot(); // fires session_start -> JobsOverlay.refresh() against the mocked connector above
			expect(h.leaks).toEqual([]); // no console.error/stderr write escaped a swallowed exception
			expect(capturedFactory, "JobsOverlay never registered a widget -- refresh() must have thrown/swallowed").toBeDefined();

			const theme = { fg: (_color: string, text: string) => text } as Theme;
			const lines = capturedFactory?.(undefined, theme).render(80) ?? [];
			expect(lines.length).toBeGreaterThan(0);
			// jobRef is column-truncated by width, so assert on stable substrings instead of the full name.
			expect(lines.some((line) => line.includes("jenkins-auto/ocp-far-ed"))).toBe(true);
			expect(lines.some((line) => line.includes("#9253"))).toBe(true);
			// Proves the actual regression's fix, not just "didn't throw": runtimeMs() successfully called
			// .getTime() on startedAt after jobs-client.ts's Date coercion -- a real elapsed duration
			// renders, rather than the whole row (and the widget's own registration) never happening.
			expect(lines.some((line) => /\d+h\d+m/.test(line))).toBe(true);
		} finally {
			await h.shutdown();
		}
	});

	it("reports a persisting fetch failure exactly once via ctx.ui.notify, not once per poll tick, then re-arms once the message changes", async () => {
		let callCount = 0;
		setJobsClientConnectorForTests(
			() =>
				({
					async call() {
						callCount++;
						if (callCount <= 3) throw new Error("daemon unreachable");
						throw new Error("daemon returned malformed payload");
					},
					// biome-ignore lint/suspicious/noExplicitAny: minimal test double, not the real PipesClient shape
				}) as any,
		);

		const notifications: Array<{ message: string; type: string }> = [];
		const h = createExtensionHarness((pi) => pipesExtension(pi, { registerVehicle: async () => undefined }));
		Object.assign(h.ctx, {
			hasUI: true,
			ui: { ...h.ctx.ui, notify: (message: string, type = "info") => notifications.push({ message, type }) },
		});

		try {
			await h.boot(); // 1st fetch fails -- session_start's own JobsOverlay.refresh()
			// session_start's handler does `jobsOverlay ??= new JobsOverlay(...)`, so re-firing it reuses
			// the same overlay instance and just calls refresh() again -- exactly like startPolling()'s own
			// repeated ticks would, without this test needing direct access to index.ts's private closure.
			await h.emit("session_start", {}); // 2nd fetch fails -- same message, must NOT notify again
			await h.emit("session_start", {}); // 3rd fetch fails -- same message, must NOT notify again
			expect(notifications.filter((n) => n.message.includes("daemon unreachable"))).toHaveLength(1);

			await h.emit("session_start", {}); // 4th call throws a DIFFERENT message -- must notify again
			expect(notifications.filter((n) => n.message.includes("daemon returned malformed payload"))).toHaveLength(1);
			expect(notifications.every((n) => n.type === "warning")).toBe(true);
		} finally {
			await h.shutdown();
		}
	});
});

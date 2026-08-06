import { describe, expect, it } from "bun:test";
import { renderToTerminal } from "@danypops/pi-tui-harness";
import type { AtomicJsonFsAdapter, VehicleClient, VehicleInvocationOptions, VehicleManifest } from "@danypops/vehicle-core";
import type { AgentToolResult, ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerPipesVehicle } from "../src/vehicle-client.ts";

/** An in-memory AtomicJsonFsAdapter -- registerPipesVehicle now touches a manifest cache file by default; this suite injects one instead of the real on-disk default. */
function fakeManifestCache(): { filePath: string; fs: AtomicJsonFsAdapter } {
	const files = new Map<string, string>();
	const fs: AtomicJsonFsAdapter = {
		writeFile(path, data) {
			files.set(path, data);
			return Promise.resolve();
		},
		rename(oldPath, newPath) {
			const data = files.get(oldPath);
			if (data === undefined) return Promise.reject(new Error(`ENOENT: ${oldPath}`));
			files.delete(oldPath);
			files.set(newPath, data);
			return Promise.resolve();
		},
		unlink(path) {
			files.delete(path);
			return Promise.resolve();
		},
		readFile(path) {
			const data = files.get(path);
			if (data === undefined) {
				const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
				error.code = "ENOENT";
				return Promise.reject(error);
			}
			return Promise.resolve(data);
		},
	};
	return { filePath: "/fake/vehicle-manifest-cache.json", fs };
}

const verdict = {
	verdict: {
		check: {
			backend: "github",
			jobRef: "publish.yml",
			runId: "30790854044",
			status: "success",
		},
	},
};

const manifest: VehicleManifest = {
	name: "pipes",
	version: "1.0.0",
	description: "Pipes.",
	operations: [
		{
			name: "ci.status",
			version: 1,
			description: "Read CI status.",
			inputSchema: { type: "object", properties: {}, required: [] },
			outputSchema: { type: "object" },
			permissions: [],
			effect: "read",
			idempotency: { mode: "safe" },
			streaming: false,
			longRunning: false,
			limits: { defaultTimeoutMs: 1_000, maxTimeoutMs: 5_000, maxRequestBytes: 1_024, maxResponseBytes: 4_096 },
			errors: [],
			available: true,
		},
	],
};

class FakeClient implements VehicleClient {
	manifest(): Promise<VehicleManifest> {
		return Promise.resolve(manifest);
	}

	invoke<Output = unknown>(_name: string, _version: number, _input: unknown, _options?: VehicleInvocationOptions): Promise<Output> {
		return Promise.resolve(verdict as Output);
	}

	close(): Promise<void> {
		return Promise.resolve();
	}
}

function captureTools(): { pi: ExtensionAPI; tools: ToolDefinition[] } {
	const tools: ToolDefinition[] = [];
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
		getAllTools: () => tools,
		getActiveTools: () => tools.map((tool) => tool.name),
		setActiveTools() {},
		on() {},
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

describe("registerPipesVehicle: generic tool-schema projection (via @danypops/vehicle-client-pi's registerVehicleTools)", () => {
	it("projects a new optional operation property straight onto the registered tool's own parameter schema, no pi-pipes-side code needed", async () => {
		// Mirrors packages/pipes/src/vehicle/pipes-vehicle.ts's real ci.subscribe schema after adding
		// subscriberId/scheduleMs -- proves the tool-exposure layer is genuinely generic: this test's
		// FakeClient never mentions "subscriberId" by name anywhere in pi-pipes' own source, only in
		// the manifest it serves, and registerVehicleTools (Vehicle Pi Client) still produces a real
		// ci_subscribe tool whose parameters carry it straight through.
		class SubscribeManifestClient implements VehicleClient {
			manifest(): Promise<VehicleManifest> {
				return Promise.resolve({
					name: "pipes",
					version: "1.0.0",
					description: "Pipes.",
					operations: [
						{
							name: "ci.subscribe",
							version: 1,
							description: "Subscribe to a job.",
							inputSchema: {
								type: "object",
								properties: {
									backend: { type: "string" },
									jobRef: { type: "string" },
									subscriberId: { type: "string" },
									scheduleMs: { type: "number" },
								},
								required: ["backend", "jobRef"],
							},
							outputSchema: { type: "object" },
							permissions: [],
							effect: "local-write",
							idempotency: { mode: "safe" },
							streaming: false,
							longRunning: false,
							limits: { defaultTimeoutMs: 1_000, maxTimeoutMs: 5_000, maxRequestBytes: 1_024, maxResponseBytes: 4_096 },
							errors: [],
							available: true,
						},
					],
				});
			}

			invoke<Output = unknown>(_name: string, _version: number, _input: unknown, _options?: VehicleInvocationOptions): Promise<Output> {
				return Promise.resolve({ subscribed: true } as Output);
			}

			close(): Promise<void> {
				return Promise.resolve();
			}
		}

		const { pi, tools } = captureTools();
		await registerPipesVehicle(pi, {
			resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "test" }),
			createClient: () => new SubscribeManifestClient(),
			manifestCache: fakeManifestCache(),
		});

		const subscribeTool = tools.find((tool) => tool.name === "ci_subscribe");
		expect(subscribeTool).toBeDefined();
		const schema = subscribeTool!.parameters as unknown as { properties?: Record<string, unknown>; required?: string[] };
		expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining(["subscriberId", "scheduleMs"]));
		expect(schema.required).not.toContain("subscriberId");
		expect(schema.required).not.toContain("scheduleMs");
	});
});

describe("registerPipesVehicle real result wiring", () => {
	it("registers its renderer while Pi is still loading, before persisted tool rows are replayed", async () => {
		const tools: ToolDefinition[] = [];
		const sessionStartHandlers: Array<() => Promise<void> | void> = [];
		let loading = true;
		const actionMethod = <T>(value: T): T => {
			if (loading) throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
			return value;
		};
		const pi = {
			registerTool(tool: ToolDefinition) {
				tools.push(tool);
			},
			getAllTools: () => actionMethod(tools),
			getActiveTools: () => actionMethod(tools.map((tool) => tool.name)),
			setActiveTools: () => actionMethod(undefined),
			on(name: string, handler: () => Promise<void> | void) {
				if (name === "session_start") sessionStartHandlers.push(handler);
			},
		} as unknown as ExtensionAPI;

		await registerPipesVehicle(pi, {
			resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "test" }),
			createClient: () => new FakeClient(),
			manifestCache: fakeManifestCache(),
		});

		expect(tools[0]?.renderResult).toBeDefined();
		loading = false;
		for (const handler of sessionStartHandlers) await handler();
	});

	it("renders execute() output as the compact CI summary instead of raw JSON", async () => {
		const { pi, tools } = captureTools();
		await registerPipesVehicle(pi, {
			resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "test" }),
			createClient: () => new FakeClient(),
			manifestCache: fakeManifestCache(),
		});

		const tool = tools[0];
		expect(tool).toBeDefined();
		const result = await tool!.execute("call-1", {}, undefined, undefined, {
			sessionManager: { getSessionId: () => "session-1" },
			hasUI: false,
		} as never);
		const component = tool!.renderResult!(result, { expanded: false, isPartial: false }, theme, { isError: false } as never);
		const terminal = await renderToTerminal(component.render(120));
		const text = terminal.plainLines().join("\n");
		terminal.dispose();

		expect(text).toContain("github/publish.yml");
		expect(text).toContain("#30790854044");
		expect(text).not.toContain('"verdict"');
		expect(text).not.toContain("{");
	});

	it("renders a still-in-flight tick's real progress, not a bare 'Running...' placeholder, for the tool's entire lifetime", async () => {
		// Mirrors vehicle-client-pi's own test/vehicle-pi.test.ts FakeClient: invoke() calls
		// options.onProgress(...) synchronously and never resolves during the assertion window,
		// exactly like a real still-running ci.wait. This is the actual invokeVehicleOperation
		// code path building the update -- {content, details: {vehicle, progress}} -- rather than
		// a hand-typed guess at that shape.
		class WaitFakeClient implements VehicleClient {
			manifest(): Promise<VehicleManifest> {
				return Promise.resolve(manifest);
			}

			invoke<Output = unknown>(_name: string, _version: number, _input: unknown, options?: VehicleInvocationOptions): Promise<Output> {
				options?.onProgress?.({
					status: "running",
					buildNumber: "9176",
					progressPercent: 42,
					overdue: false,
					tail: { text: "line one\nline two", truncated: false },
				});
				return new Promise(() => {}); // still running -- only the tick matters for this assertion.
			}

			close(): Promise<void> {
				return Promise.resolve();
			}
		}

		const { pi, tools } = captureTools();
		await registerPipesVehicle(pi, {
			resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "test" }),
			createClient: () => new WaitFakeClient(),
			manifestCache: fakeManifestCache(),
		});

		const tool = tools[0];
		let partial: AgentToolResult<unknown> | undefined;
		void tool!.execute(
			"call-1",
			{},
			undefined,
			(update) => {
				partial = update;
			},
			{ sessionManager: { getSessionId: () => "session-1" }, hasUI: false } as never,
		);
		// invokeVehicleOperation hops through a few microtasks (awaiting the undefined
		// resolveInvocation, etc.) before actually calling client.invoke() -- a macrotask flush
		// guarantees the tick has landed regardless of how many microtask hops that takes.
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(partial).toBeDefined();
		const component = tool!.renderResult!(partial!, { expanded: false, isPartial: true }, theme, { isError: false } as never);
		const terminal = await renderToTerminal(component.render(120));
		const text = terminal.plainLines().join("\n");
		terminal.dispose();

		expect(text).toContain("42%");
		expect(text).toContain("#9176");
		expect(text).toContain("line two");
	});
});

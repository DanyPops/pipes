import { beforeEach, describe, expect, it } from "bun:test";
import { __resetInProcessVehicleRegistryForTests, __resetVehicleShellHandleForTests } from "@danypops/vehicle-client-pi/test-utils";
import type {
	AtomicJsonFsAdapter,
	VehicleClient,
	VehicleInvocationOptions,
	VehicleManifest,
	VehicleManifestOperation,
} from "@danypops/vehicle-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	isPipesVehicleTool,
	type PipesVehicleDeps,
	registerPipesVehicle,
	resolvePipesProgressBarStyle,
	withConnectorDiagnostics,
} from "../src/vehicle-client.ts";

/** An in-memory AtomicJsonFsAdapter -- registerPipesVehicle now touches a manifest cache file by default; every test must inject one of these instead of the real on-disk default. */
function fakeFs(): AtomicJsonFsAdapter {
	const files = new Map<string, string>();
	return {
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
}

function fakeManifestCache(): { filePath: string; fs: AtomicJsonFsAdapter } {
	return { filePath: "/fake/vehicle-manifest-cache.json", fs: fakeFs() };
}

type FakeEventHandler = (event: unknown, ctx: unknown) => Promise<void> | void;

const limits = { defaultTimeoutMs: 1_000, maxTimeoutMs: 5_000, maxRequestBytes: 1_024, maxResponseBytes: 1_024 };

function operation(name: string, overrides: Partial<VehicleManifestOperation> = {}): VehicleManifestOperation {
	return {
		name,
		version: 1,
		description: `Run ${name}.`,
		inputSchema: { type: "object", properties: { backend: { type: "string" } }, required: [] },
		outputSchema: { type: "object" },
		permissions: [],
		effect: "read",
		idempotency: { mode: "safe" },
		streaming: false,
		longRunning: false,
		limits,
		errors: [],
		available: true,
		...overrides,
	};
}

class FakeClient implements VehicleClient {
	closed = false;
	result: unknown = { ok: true };

	constructor(private value: VehicleManifest) {}

	setManifest(value: VehicleManifest): void {
		this.value = value;
	}

	manifest(): Promise<VehicleManifest> {
		return Promise.resolve(this.value);
	}

	async invoke<Output = unknown>(_name: string, _version: number, _input: unknown, _options?: VehicleInvocationOptions): Promise<Output> {
		return this.result as Output;
	}

	close(): Promise<void> {
		this.closed = true;
		return Promise.resolve();
	}
}

function manifest(operations: VehicleManifestOperation[]): VehicleManifest {
	return { name: "pipes", version: "1.0.0", description: "Pipes.", operations };
}

function fakePi() {
	const tools: ToolDefinition[] = [];
	let active: string[] = [];
	const handlers: Record<string, FakeEventHandler[]> = {};
	const pi = {
		registerTool: (tool: ToolDefinition) => {
			tools.push(tool);
			active.push(tool.name);
		},
		getAllTools: () => tools,
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
		on: (event: string, handler: FakeEventHandler) => {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
		},
	} as unknown as ExtensionAPI;
	const fire = async (event: string, toolName?: string) => {
		for (const handler of handlers[event] ?? []) await handler({ toolName }, {});
	};
	return { pi, tools, active: () => active, fire };
}

describe("registerPipesVehicle", () => {
	it("does nothing when the daemon has never started (no target resolves)", async () => {
		const { pi, tools } = fakePi();
		const deps: PipesVehicleDeps = { resolveTarget: () => undefined };
		const result = await registerPipesVehicle(pi, deps);
		expect(result).toBeUndefined();
		expect(tools).toHaveLength(0);
	});

	it("degrades silently when the client construction or manifest fetch throws, and nothing was ever cached", async () => {
		const { pi } = fakePi();
		const deps: PipesVehicleDeps = {
			resolveTarget: () => ({ baseUrl: "http://127.0.0.1:1", token: "t" }),
			createClient: () => {
				throw new Error("connection refused");
			},
			manifestCache: fakeManifestCache(),
			// "connection refused" is stale-connection-shaped -- without disabling connectRetry
			// here, this would wait out the real ~5s background retry budget (see vehicle-client's
			// own DEFAULT_CONNECT_RETRY) before degrading.
			connectRetry: false,
		};
		const result = await registerPipesVehicle(pi, deps);
		expect(result).toBeUndefined();
	});

	it("falls back to a previously-cached manifest instead of degrading to undefined, when the daemon is unreachable but a prior registration succeeded", async () => {
		const manifestCache = fakeManifestCache();
		const warmClient = new FakeClient(manifest([operation("ci.status")]));
		await registerPipesVehicle(fakePi().pi, {
			resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
			createClient: () => warmClient,
			manifestCache,
		});

		const { pi, tools } = fakePi();
		const deps: PipesVehicleDeps = {
			resolveTarget: () => ({ baseUrl: "http://127.0.0.1:1", token: "t" }),
			createClient: () => {
				throw new Error("connection refused");
			},
			manifestCache,
			// Unrelated to broker/shell mode -- disabled so this test's registered-tool-names
			// assertion stays about the manifest-cache fallback, not shell's own meta-tools.
			shell: undefined,
			// "connection refused" is stale-connection-shaped -- without disabling connectRetry
			// here, this would wait out the real ~5s background retry budget (see vehicle-client's
			// own DEFAULT_CONNECT_RETRY) before falling back to the cached manifest.
			connectRetry: false,
		};
		const result = await registerPipesVehicle(pi, deps);
		expect(result?.stale).toBe(true);
		expect(result?.tools.map((t) => t.toolName)).toEqual(["ci_status"]);
		expect(tools.map((t) => t.name)).toEqual(["ci_status"]);
	});

	it("registers one Pi tool per real operation when a target resolves, using the dotted-to-underscore projection", async () => {
		const { pi, tools } = fakePi();
		const client = new FakeClient(manifest([operation("ci.status"), operation("ci.presets.list")]));
		const deps: PipesVehicleDeps = {
			resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
			createClient: () => client,
			manifestCache: fakeManifestCache(),
			shell: undefined,
		};
		const result = await registerPipesVehicle(pi, deps);
		expect(result?.tools.map((t) => t.toolName).sort()).toEqual(["ci_presets_list", "ci_status"]);
		expect(tools.map((t) => t.name).sort()).toEqual(["ci_presets_list", "ci_status"]);
	});

	it("wires renderCall/renderResult for every registered operation, using ci-render.ts's shape-driven rendering", async () => {
		const { pi, tools } = fakePi();
		const client = new FakeClient(manifest([operation("ci.trigger")]));
		const deps: PipesVehicleDeps = {
			resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
			createClient: () => client,
			manifestCache: fakeManifestCache(),
		};
		await registerPipesVehicle(pi, deps);
		const tool = tools[0];
		expect(tool?.renderCall).toBeDefined();
		expect(tool?.renderResult).toBeDefined();
	});
});

// registerVehicleTools()'s shared Vehicle Shell handle and in-process vehicle registry are both
// process-wide globalThis singletons -- bun test runs this whole package's test files in one
// process, so an earlier test's own registration would otherwise silently "win" the shared handle
// forever, leaving a later test's own fresh fake pi with tools_list/tools_man never registered on
// it at all. See @danypops/vehicle-client-pi/test-utils's own doc comment.
beforeEach(() => {
	__resetVehicleShellHandleForTests();
	__resetInProcessVehicleRegistryForTests();
});

describe("registerPipesVehicle: Vehicle Shell broker mode", () => {
	it("defaults to shell mode on: core operations active immediately, everything else behind tools_man, and returns a shell handle for broker discovery", async () => {
		const { pi, active } = fakePi();
		const client = new FakeClient(manifest([operation("ci.status"), operation("ci.chain"), operation("rp.launches")]));
		const deps: PipesVehicleDeps = {
			resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
			createClient: () => client,
			manifestCache: fakeManifestCache(),
		};

		const result = await registerPipesVehicle(pi, deps);

		expect(result?.shell).toBeDefined();
		expect(active().sort()).toEqual(["ci_status", "tools_list", "tools_man", "tools_type"].sort());
	});
});

describe("registerPipesVehicle's availability refresh", () => {
	it("re-syncs tool availability after one of its own tools runs, picking up a newly-unavailable operation", async () => {
		const { pi, active, fire } = fakePi();
		const client = new FakeClient(manifest([operation("ci.status"), operation("ci.discover")]));
		const deps: PipesVehicleDeps = {
			resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
			createClient: () => client,
			manifestCache: fakeManifestCache(),
			// Unrelated to broker/shell mode -- disabled here so this test's own active-set assertions
			// stay about availability refresh, not which operations happen to be "core".
			shell: undefined,
		};
		await registerPipesVehicle(pi, deps);
		expect(active().sort()).toEqual(["ci_discover", "ci_status"]);

		client.setManifest(manifest([operation("ci.status"), operation("ci.discover", { available: false })]));
		await fire("tool_execution_end", "ci_status");

		expect(active().sort()).toEqual(["ci_status"]);
	});

	it("does not refresh for a tool call outside the pipes namespace", async () => {
		const { pi, active, fire } = fakePi();
		const client = new FakeClient(manifest([operation("ci.discover")]));
		const deps: PipesVehicleDeps = {
			resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
			createClient: () => client,
			manifestCache: fakeManifestCache(),
			shell: undefined,
		};
		await registerPipesVehicle(pi, deps);

		client.setManifest(manifest([operation("ci.discover", { available: false })]));
		await fire("tool_execution_end", "read");

		expect(active()).toEqual(["ci_discover"]);
	});
});

describe("withConnectorDiagnostics", () => {
	it("classifies a stale Pipes transport without leaking its URL, token, or raw cause", async () => {
		const raw = new FakeClient(manifest([operation("ci.status")]));
		raw.invoke = () => Promise.reject(new TypeError("fetch failed: ECONNREFUSED http://127.0.0.1:40917 token=secret"));
		const client = withConnectorDiagnostics(raw);

		const failure = await client.invoke("ci.status", 1, { pipeline: "lector-ci" }).catch((error: unknown) => error);

		expect(failure).toMatchObject({ code: "connector-unavailable", category: "unavailable", retryable: true });
		expect((failure as Error).message).toContain('ci.status for pipeline "lector-ci"');
		expect((failure as Error).message).toContain("retry");
		expect((failure as Error).message).not.toContain("40917");
		expect((failure as Error).message).not.toContain("secret");
	});
});

describe("resolvePipesProgressBarStyle", () => {
	it("defaults to the bordered blocks visual and accepts every supported human selection", () => {
		expect(resolvePipesProgressBarStyle(undefined)).toBe("blocks");
		for (const style of ["shade", "smooth", "blocks", "ascii"] as const) expect(resolvePipesProgressBarStyle(style)).toBe(style);
		expect(resolvePipesProgressBarStyle("unknown")).toBe("blocks");
	});
});

describe("isPipesVehicleTool", () => {
	it("recognizes every real projected tool namespace", () => {
		expect(isPipesVehicleTool("ci_status")).toBe(true);
		expect(isPipesVehicleTool("ci_presets_list")).toBe(true);
	});

	it("recognizes Report Portal's own rp_ namespace, not just ci_", () => {
		expect(isPipesVehicleTool("rp_launches")).toBe(true);
		expect(isPipesVehicleTool("rp_dashboard_create")).toBe(true);
	});

	it("rejects an unrelated tool name", () => {
		expect(isPipesVehicleTool("read")).toBe(false);
		expect(isPipesVehicleTool("bash")).toBe(false);
	});
});

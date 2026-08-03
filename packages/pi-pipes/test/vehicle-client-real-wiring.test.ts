import { describe, expect, it } from "bun:test";
import { renderToTerminal } from "@danypops/pi-tui-harness";
import type { VehicleClient, VehicleInvocationOptions, VehicleManifest } from "@danypops/vehicle-core";
import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerPipesVehicle } from "../src/vehicle-client.ts";

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

describe("registerPipesVehicle real result wiring", () => {
	it("renders execute() output as the compact CI summary instead of raw JSON", async () => {
		const { pi, tools } = captureTools();
		await registerPipesVehicle(pi, {
			resolveTarget: () => ({ baseUrl: "http://127.0.0.1:9", token: "test" }),
			createClient: () => new FakeClient(),
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
});

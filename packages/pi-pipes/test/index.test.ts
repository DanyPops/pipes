import { afterEach, describe, expect, it } from "bun:test";
import {
	__resetSecretsRegistryForTests,
	claimSecretsCommandName,
	listSecretsContributors,
} from "@danypops/vehicle-client-pi/secrets-registry";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pipesExtension, { type PiPipesDeps } from "../src/index.ts";
import { resetJobsClientConnectorForTests, setJobsClientConnectorForTests } from "../src/jobs-client.ts";

// biome-ignore lint/suspicious/noExplicitAny: fake event/ctx pair -- only the fields each test actually reads are ever populated.
type FakeEventHandler = (event: any, ctx: any) => Promise<void> | void;

function fakePi(): {
	pi: ExtensionAPI;
	commands: string[];
	tools: string[];
	// biome-ignore lint/suspicious/noExplicitAny: see FakeEventHandler
	fire: (event: string, ctx?: any) => Promise<void>;
} {
	const commands: string[] = [];
	const tools: string[] = [];
	const handlers: Record<string, FakeEventHandler[]> = {};
	const pi = {
		registerCommand: (name: string) => commands.push(name),
		registerTool: (def: { name: string }) => tools.push(def.name),
		on: (event: string, handler: FakeEventHandler) => {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
		},
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => {},
	} as unknown as ExtensionAPI;
	// biome-ignore lint/suspicious/noExplicitAny: see FakeEventHandler
	const fire = async (event: string, ctx: any = {}) => {
		for (const handler of handlers[event] ?? []) await handler({ type: event }, ctx);
	};
	return { pi, commands, tools, fire };
}

describe("pipesExtension", () => {
	it("awaits Vehicle registration in the extension factory so renderers exist before transcript replay", async () => {
		__resetSecretsRegistryForTests();
		const { pi, commands } = fakePi();
		let vehicleCalled = false;
		const deps: PiPipesDeps = {
			registerVehicle: async () => {
				vehicleCalled = true;
				return undefined;
			},
		};

		await pipesExtension(pi, deps);

		expect(commands).toContain("pipes");
		expect(vehicleCalled).toBe(true);
	});

	it("contributes to the shared /secrets namespace, claiming the real registration when nothing else has", () => {
		__resetSecretsRegistryForTests();
		const { pi, commands } = fakePi();
		pipesExtension(pi, { registerVehicle: async () => undefined });
		expect(commands).toContain("secrets");
		expect(listSecretsContributors().map((c) => c.source)).toEqual(["pipes"]);
	});

	it("still contributes, without a second command registration, when another consumer already claimed /secrets", () => {
		__resetSecretsRegistryForTests();
		claimSecretsCommandName("secrets"); // simulate pi-enigma or pi-tickets having loaded first
		const { pi, commands } = fakePi();
		pipesExtension(pi, { registerVehicle: async () => undefined });
		expect(commands).not.toContain("secrets");
		expect(listSecretsContributors().map((c) => c.source)).toEqual(["pipes"]);
	});
});

describe("pipesExtension: subscribed-jobs widget", () => {
	afterEach(resetJobsClientConnectorForTests);

	it("registers the jobs widget on session_start once at least one job is subscribed, only when the session has a UI", async () => {
		setJobsClientConnectorForTests(
			() =>
				({
					async call() {
						return {
							runs: [
								{
									backend: "jenkins-auto",
									jobRef: "job",
									runId: "1",
									status: "running",
									result: "",
									url: "",
									startedAt: new Date(0),
									fetchedAt: new Date(0),
									watched: true,
								},
							],
						};
					},
					// biome-ignore lint/suspicious/noExplicitAny: minimal test double, not the real PipesClient shape
				}) as any,
		);
		const { pi, fire } = fakePi();
		await pipesExtension(pi, { registerVehicle: async () => undefined });

		let registeredKey: string | undefined;
		const ui = { setWidget: (key: string, factory: unknown) => (registeredKey = factory === undefined ? undefined : key) };
		await fire("session_start", { hasUI: true, ui });

		expect(registeredKey).toBeDefined();
	});

	it("never touches the daemon or ui when the session has no UI", async () => {
		let called = false;
		setJobsClientConnectorForTests(() => {
			called = true;
			throw new Error("must not be called for a headless session");
		});
		const { pi, fire } = fakePi();
		await pipesExtension(pi, { registerVehicle: async () => undefined });

		await fire("session_start", { hasUI: false });

		expect(called).toBe(false);
	});

	it("disposes the widget on session_shutdown", async () => {
		setJobsClientConnectorForTests(
			() =>
				({
					async call() {
						return {
							runs: [
								{
									backend: "gh",
									jobRef: "job",
									runId: "1",
									status: "running",
									result: "",
									url: "",
									startedAt: new Date(0),
									fetchedAt: new Date(0),
									watched: true,
								},
							],
						};
					},
					// biome-ignore lint/suspicious/noExplicitAny: minimal test double, not the real PipesClient shape
				}) as any,
		);
		const { pi, fire } = fakePi();
		await pipesExtension(pi, { registerVehicle: async () => undefined });

		let registeredKey: string | undefined;
		const ui = { setWidget: (key: string, factory: unknown) => (registeredKey = factory === undefined ? undefined : key) };
		await fire("session_start", { hasUI: true, ui });
		expect(registeredKey).toBeDefined();

		await fire("session_shutdown", {});
		expect(registeredKey).toBeUndefined();
	});
});

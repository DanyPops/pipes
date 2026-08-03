import { describe, expect, it } from "bun:test";
import {
	__resetSecretsRegistryForTests,
	claimSecretsCommandName,
	listSecretsContributors,
} from "@danypops/vehicle-client-pi/secrets-registry";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pipesExtension, { type PiPipesDeps } from "../src/index.ts";

type FakeEventHandler = () => Promise<void> | void;

function fakePi(): { pi: ExtensionAPI; commands: string[]; tools: string[]; fire: (event: string) => Promise<void> } {
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
	const fire = async (event: string) => {
		for (const handler of handlers[event] ?? []) await handler();
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

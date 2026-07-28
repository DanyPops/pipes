import { describe, expect, it } from "bun:test";
import { __resetSecretsRegistryForTests, claimSecretsCommandName, listSecretsContributors } from "@danypops/daemon-kit/secrets-registry";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pipesExtension from "../src/index.ts";

function fakePi(): { pi: ExtensionAPI; commands: string[]; tools: string[] } {
	const commands: string[] = [];
	const tools: string[] = [];
	const pi = {
		registerCommand: (name: string) => commands.push(name),
		registerTool: (def: { name: string }) => tools.push(def.name),
	} as unknown as ExtensionAPI;
	return { pi, commands, tools };
}

describe("pipesExtension", () => {
	it("registers the 'ci' tool and the /pipes command", () => {
		__resetSecretsRegistryForTests();
		const { pi, commands, tools } = fakePi();
		pipesExtension(pi);
		expect(tools).toContain("ci");
		expect(commands).toContain("pipes");
	});

	it("contributes to the shared /secrets namespace, claiming the real registration when nothing else has", () => {
		__resetSecretsRegistryForTests();
		const { pi, commands } = fakePi();
		pipesExtension(pi);
		expect(commands).toContain("secrets");
		expect(listSecretsContributors().map((c) => c.source)).toEqual(["pipes"]);
	});

	it("still contributes, without a second command registration, when another consumer already claimed /secrets", () => {
		__resetSecretsRegistryForTests();
		claimSecretsCommandName("secrets"); // simulate pi-enigma or pi-tickets having loaded first
		const { pi, commands } = fakePi();
		pipesExtension(pi);
		expect(commands).not.toContain("secrets");
		expect(listSecretsContributors().map((c) => c.source)).toEqual(["pipes"]);
	});
});

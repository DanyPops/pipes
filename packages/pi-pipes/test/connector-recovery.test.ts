import { afterEach, describe, expect, it } from "bun:test";
import { createReconnectingVehicleClient } from "@danypops/vehicle-client/daemon-client";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import { Orchestrator } from "../../pipes/src/orchestrator.ts";
import { createApp, createPipesService } from "../../pipes/src/rpc/service.ts";
import { createStubCIBackend } from "../../pipes/test/fixtures/stub-ci-backend.ts";
import { withConnectorDiagnostics } from "../src/connector-diagnostics.ts";

const TOKEN = "connector-recovery-test-token";
const PERMISSIONS = ["pipes:read", "pipes:write"];

function serviceWithConfiguredPipeline() {
	const orchestrator = new Orchestrator();
	orchestrator.addAdapter(
		createStubCIBackend({
			name: "gh",
			runsById: { latest: { id: "42", name: "build", status: "success", startedAt: new Date(0) } },
		}),
	);
	orchestrator.registerPipeline({ name: "lector-ci", backend: "gh", steps: [{ jobName: "build" }] });
	return createPipesService(orchestrator);
}

describe("connector drop and recovery", () => {
	const servers: ReturnType<typeof Bun.serve>[] = [];
	afterEach(() => {
		for (const server of servers) server.stop(true);
		servers.length = 0;
	});

	function startServer(): string {
		const app = createApp({ service: serviceWithConfiguredPipeline(), token: TOKEN });
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
		servers.push(server);
		return `http://127.0.0.1:${server.port}`;
	}

	it("keeps preset identity across a real dead connector and reconnects without setting it again", async () => {
		let baseUrl = startServer();
		const client = withConnectorDiagnostics(
			createReconnectingVehicleClient(async () => new RemoteVehicleClient({ baseUrl, token: TOKEN })),
		);

		const before = (await client.invoke("ci.presets.list", 1, {}, { permissions: PERMISSIONS })) as { presets: Array<{ name: string }> };
		expect(before.presets.map((preset) => preset.name)).toEqual(["lector-ci"]);
		expect(await client.invoke("ci.status", 1, { pipeline: "lector-ci" }, { permissions: PERMISSIONS })).toMatchObject({
			pipelineRun: { pipeline: "lector-ci", status: "success", steps: [{ runId: "42" }] },
		});

		servers[0]!.stop(true);
		const unavailable = await client
			.invoke("ci.status", 1, { pipeline: "lector-ci" }, { permissions: PERMISSIONS })
			.catch((error: unknown) => error);
		expect(unavailable).toMatchObject({ code: "connector-unavailable", category: "unavailable" });
		expect((unavailable as Error).message).not.toContain(TOKEN);
		// Listing while disconnected is consistently classified as connector state;
		// it never mutates or reclassifies the known preset as missing.
		const unavailableList = await client.invoke("ci.presets.list", 1, {}, { permissions: PERMISSIONS }).catch((error: unknown) => error);
		expect(unavailableList).toMatchObject({ code: "connector-unavailable", category: "unavailable" });

		baseUrl = startServer();
		const after = (await client.invoke("ci.presets.list", 1, {}, { permissions: PERMISSIONS })) as { presets: Array<{ name: string }> };
		expect(after.presets.map((preset) => preset.name)).toEqual(before.presets.map((preset) => preset.name));
		expect(await client.invoke("ci.status", 1, { pipeline: "lector-ci" }, { permissions: PERMISSIONS })).toMatchObject({
			pipelineRun: { pipeline: "lector-ci", status: "success", steps: [{ runId: "42" }] },
		});
	});
});

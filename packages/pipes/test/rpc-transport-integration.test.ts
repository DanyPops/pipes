/** Exercises createApp/createPipesService end to end, in-process, over the authenticated transport (auth, /health, /ready, /api/v1/ops). */
import { describe, expect, it } from "bun:test";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import { AuthenticatedRpcClient } from "@danypops/vehicle-client/rpc-client";
import { openVehicleMetricsStore } from "@danypops/vehicle-server/metrics";
import { createVehicleMetricsMiddleware } from "@danypops/vehicle-server/metrics-middleware";
import { registerVehicleMetricsOperations } from "@danypops/vehicle-server/metrics-operations";
import { Orchestrator } from "../src/orchestrator.ts";
import { createApp, createPipesService, type OperationInputs, type OperationName, type OperationOutputs } from "../src/rpc/service.ts";

const TOKEN = "test-token";

function buildApp() {
	return createApp({ service: createPipesService(new Orchestrator()), token: TOKEN });
}

function buildClient(app: ReturnType<typeof buildApp>) {
	return new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>("http://pipes.local", TOKEN, {
		label: "Pipes",
		transport: (request) => app.fetch(request),
	});
}

describe("pipes RPC transport integration: vehicle metrics (mirrors process/daemon.ts's own wiring)", () => {
	it("a real Vehicle-surface op call is recorded by the wired-in metrics store, discoverable through the manifest itself", async () => {
		// Deliberately NOT AuthenticatedRpcClient/`/api/v1/ops` -- that's Pipes' own separate, hand-
		// written native RPC surface (see createApp's own doc comment); only `/vehicle/*` (routed to
		// service.vehicle) reaches the execution middleware metrics are wired onto. pi-pipes' own real
		// vehicle-client.ts uses RemoteVehicleClient against exactly this surface.
		const service = createPipesService(new Orchestrator());
		const metrics = openVehicleMetricsStore(":memory:");
		service.vehicle.useExecutionMiddleware(createVehicleMetricsMiddleware(metrics, "pipes"));
		registerVehicleMetricsOperations(service.vehicle, metrics, "pipes");
		const app = createApp({ service, token: TOKEN });

		const vehicleClient = new RemoteVehicleClient({
			baseUrl: "http://pipes.local",
			token: TOKEN,
			// Cast: Bun's own `typeof fetch` type additionally requires a static `.preconnect` this
			// in-process transport override has no use for -- same shape every other real caller of
			// this option already accepts (the actual invocation is a plain 2-arg fetch call).
			fetch: ((input: string | Request | URL, init?: RequestInit) =>
				app.fetch(new Request(input as string, init))) as unknown as typeof fetch,
		});

		const manifest = await vehicleClient.manifest();
		expect(manifest.operations.map((op) => op.name)).toContain("metrics.query");
		expect(manifest.operations.map((op) => op.name)).toContain("metrics.recordClientEvent");

		await vehicleClient.invoke("ci.help", 1, {}, { permissions: ["pipes:read", "pipes:write"] });

		const rows = metrics.query({ toolName: "ci.help" });
		expect(rows[0]).toMatchObject({ count: 1, successCount: 1, failureCount: 0 });

		await vehicleClient.close();
	});
});

describe("pipes RPC transport integration", () => {
	it("serves health, ready, ops discovery, and ci.help over the authenticated transport", async () => {
		const client = buildClient(buildApp());

		const health = await client.health();
		expect(health.ok).toBe(true);
		expect(typeof health.version).toBe("string");

		expect(await client.ready()).toBe(true);
		expect(await client.operations()).toContain("ci.help");
		expect(await client.call("ci.help", {})).toEqual({ backends: [], pipelines: [] });
	});

	it("rejects requests without a valid bearer token", async () => {
		const response = await buildApp().fetch(new Request("http://pipes.local/health"));
		expect(response.status).toBe(401);
	});

	it("maps a not-found backend to HTTP 404, not a generic 400", async () => {
		const app = buildApp();
		const response = await app.fetch(
			new Request("http://pipes.local/api/v1/ops", {
				method: "POST",
				headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
				body: JSON.stringify({ op: "ci.search", input: { backend: "missing", jobRef: "job" } }),
			}),
		);
		expect(response.status).toBe(404);
	});
});

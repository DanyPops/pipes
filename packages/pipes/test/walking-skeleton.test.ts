/** Exercises createApp/createPipesService end to end, in-process, over the authenticated transport (auth, /health, /ready, /api/v1/ops). */
import { describe, expect, it } from "bun:test";
import { AuthenticatedRpcClient } from "@danypops/vehicle-client/rpc-client";
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

describe("pipes walking skeleton", () => {
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

/** Exercises createApp/createPipesService end to end, in-process, over the authenticated transport (auth, /health, /ready, /api/v1/ops). */
import { describe, expect, it } from "bun:test";
import { AuthenticatedRpcClient } from "@danypops/daemon-kit/rpc-client";
import { createApp, createPipesService } from "../src/service.ts";

const TOKEN = "test-token";

describe("pipes-daemon walking skeleton", () => {
	it("serves health, ready, ops discovery, and backends.list over the authenticated transport", async () => {
		const app = createApp({ service: createPipesService(), token: TOKEN });
		const client = new AuthenticatedRpcClient<"backends.list", { "backends.list": Record<string, never> }, { "backends.list": { backends: string[] } }>(
			"http://pipes.local",
			TOKEN,
			{ label: "Pipes", transport: (request) => app.fetch(request) },
		);

		const health = await client.health();
		expect(health.ok).toBe(true);
		expect(typeof health.version).toBe("string");

		expect(await client.ready()).toBe(true);
		expect(await client.operations()).toEqual(["backends.list"]);
		expect(await client.call("backends.list", {})).toEqual({ backends: [] });
	});

	it("rejects requests without a valid bearer token", async () => {
		const app = createApp({ service: createPipesService(), token: TOKEN });
		const response = await app.fetch(new Request("http://pipes.local/health"));
		expect(response.status).toBe(401);
	});
});

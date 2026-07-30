/** PipesClient.call must never hang forever against a wedged daemon -- see daemon-client.ts's own doc comment on why the client enforces its own deadline independent of the daemon's HTTP response. */
import { describe, expect, it } from "bun:test";
import { PipesClient } from "../src/daemon-client.ts";

describe("PipesClient.call: bounded against a wedged daemon", () => {
	it("rejects with a clear timeout error instead of hanging when the daemon never responds", async () => {
		const client = new PipesClient("http://127.0.0.1:1", "token", () => new Promise<Response>(() => {}));

		await expect(client.call("ci.status", {}, 10)).rejects.toThrow(/timed out/i);
	});

	it("resolves normally when the daemon responds before the deadline", async () => {
		const client = new PipesClient("http://127.0.0.1:1", "token", async () => new Response(JSON.stringify({ result: { ok: true } }), { status: 200 }));

		await expect(client.call("ci.status", {}, 5_000)).resolves.toEqual({ ok: true });
	});

	it("uses a sane default deadline when none is given, without requiring every call site to pass one", async () => {
		const client = new PipesClient("http://127.0.0.1:1", "token", async () => new Response(JSON.stringify({ result: { ok: true } }), { status: 200 }));

		await expect(client.call("ci.status", {})).resolves.toEqual({ ok: true });
	});
});

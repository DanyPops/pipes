/**
 * Real-HTTP-wire regression coverage for the Jobs widget's own "not showing up" bug: every other
 * test in this directory (pipes-vehicle.test.ts) and in rpc/service.test.ts drives either
 * service.execute(op, input, callContext) or service.vehicle.invoke(...) directly, in-process --
 * exactly the "LocalVehicleClient-shaped" path @danypops/vehicle-client@0.8.1's own fix commit
 * (91aed2f, "carry callerSessionId/callerProjectRoot over the real Vehicle HTTP wire") calls out as
 * blind to the bug: RemoteVehicleClient.invoke() silently never put callerSessionId/
 * callerProjectRoot in its request body, and the HTTP provider never read them back even if it had.
 *
 * Concretely, this is what actually happens when pi-pipes' own vehicle-client.ts drives ci_trigger/
 * ci_subscribe over a real daemon process: registerVehicleTools -> invokeVehicleOperation (computes
 * callerSessionId correctly, client-side) -> RemoteVehicleClient.invoke() (HTTP) -> the daemon's own
 * vehicle-http-provider -> VehicleRegistry.invoke() -> pipes-vehicle.ts's operation handler ->
 * service.execute(..., { callerSessionId, callerProjectRoot }). Only a real HTTP hop between steps
 * 2 and 3 can prove the field actually survives -- this file is that hop, mirroring the shape of
 * vehicle-client's own new vehicle-http.test.ts coverage, but asserting pipes' own observable
 * consequence (job_watches' subscriber_id, ci.subscribed's own filtering) rather than a generic
 * echo operation.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import { createVehicleHttpApp } from "@danypops/vehicle-server/http";
import { Orchestrator } from "../../src/orchestrator.ts";
import { createPipesService, type PipesService } from "../../src/rpc/service.ts";
import { Capability } from "../../src/run/ci-backend.ts";
import { openPipesDb } from "../../src/sqlite/db.ts";
import { createRunPool, type RunPool } from "../../src/sqlite/run-pool.ts";
import { createStubCIBackend } from "../fixtures/stub-ci-backend.ts";

const TOKEN = "test-token";
const PERMS = ["pipes:read", "pipes:write"];

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
	server?.stop(true);
	server = undefined;
});

function startRealDaemon(service: PipesService): { baseUrl: string } {
	const app = createVehicleHttpApp({ registry: service.vehicle, token: TOKEN });
	server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
	return { baseUrl: `http://127.0.0.1:${server.port}` };
}

function harness(): { service: PipesService; runPool: RunPool } {
	const orchestrator = new Orchestrator();
	orchestrator.addAdapter(
		createStubCIBackend({
			name: "gh",
			capabilities: Capability.Trigger,
			// Deliberately "running", not "success" -- a terminal status would immediately
			// self-unsubscribe right after the auto-subscribe this test observes.
			run: { id: "1", name: "run", status: "running", startedAt: new Date(0) },
			triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "7" },
		}),
	);
	const runPool = createRunPool(openPipesDb(":memory:"));
	const service = createPipesService(orchestrator, { runPool });
	return { service, runPool };
}

describe("ci.trigger / ci.subscribe over a real HTTP round trip (RemoteVehicleClient -> vehicle-http-provider)", () => {
	it("attributes ci.trigger's own auto-subscription to the real callerSessionId sent over the wire, not the anonymous bucket (regression: the wire silently dropped it)", async () => {
		const { service, runPool } = harness();
		const { baseUrl } = startRealDaemon(service);
		const client = new RemoteVehicleClient({ baseUrl, token: TOKEN });

		await client.invoke(
			"ci.trigger",
			1,
			{ backend: "gh", jobRef: "job", params: {} },
			{ permissions: PERMS, callerSessionId: "session-42" },
		);

		expect(runPool.isJobSubscribed("gh", "job", "session-42")).toBe(true);
		expect(runPool.isJobSubscribed("gh", "job", "")).toBe(false);
	});

	it("ci.subscribe defaults subscriberId to the real callerSessionId sent over the wire, not the anonymous bucket", async () => {
		const { service, runPool } = harness();
		const { baseUrl } = startRealDaemon(service);
		const client = new RemoteVehicleClient({ baseUrl, token: TOKEN });

		await client.invoke("ci.subscribe", 1, { backend: "gh", jobRef: "job" }, { permissions: PERMS, callerSessionId: "session-42" });

		expect(runPool.isJobSubscribed("gh", "job", "session-42")).toBe(true);
		expect(runPool.isJobSubscribed("gh", "job", "")).toBe(false);
	});

	it("ci.subscribed, scoped to that same real session id, actually sees the job -- the Jobs widget's own exact read path", async () => {
		const { service } = harness();
		const { baseUrl } = startRealDaemon(service);
		const client = new RemoteVehicleClient({ baseUrl, token: TOKEN });

		await client.invoke(
			"ci.trigger",
			1,
			{ backend: "gh", jobRef: "job", params: {} },
			{ permissions: PERMS, callerSessionId: "session-42" },
		);

		const scoped = (await client.invoke("ci.subscribed", 1, { subscriberId: "session-42" }, { permissions: PERMS })) as {
			runs: Array<{ jobRef: string }>;
		};
		expect(scoped.runs.some((run) => run.jobRef === "job")).toBe(true);

		// A different session's own scoped view must NOT see it -- the cross-session leak fix
		// (1492814) this same widget code path depends on staying correct alongside this one.
		const otherSession = (await client.invoke("ci.subscribed", 1, { subscriberId: "someone-else" }, { permissions: PERMS })) as {
			runs: Array<{ jobRef: string }>;
		};
		expect(otherSession.runs.some((run) => run.jobRef === "job")).toBe(false);
	});
});

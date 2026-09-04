import { describe, expect, it } from "bun:test";
import { Orchestrator } from "../../src/orchestrator.ts";
import { createPipesService, OPERATION_NAMES, type PipesService } from "../../src/rpc/service.ts";
import { Capability } from "../../src/run/ci-backend.ts";
import { createPipesVehicleRegistry } from "../../src/vehicle/pipes-vehicle.ts";
import { VERSION } from "../../src/version.ts";
import { createStubCIBackend } from "../fixtures/stub-ci-backend.ts";

const PERMS = { permissions: ["pipes:read", "pipes:write"] };

function harness(): { service: PipesService; orchestrator: Orchestrator } {
	const orchestrator = new Orchestrator();
	orchestrator.addAdapter(
		createStubCIBackend({
			name: "gh",
			capabilities: Capability.Trigger | Capability.History,
			run: { id: "1", name: "run", status: "success", startedAt: new Date(0) },
		}),
	);
	const service = createPipesService(orchestrator);
	return { service, orchestrator };
}

describe("createPipesVehicleRegistry (via PipesService.vehicle)", () => {
	it("reports the real package version in the manifest identity, not a hardcoded placeholder", () => {
		const { service } = harness();
		expect(service.vehicle.manifest().version).toBe(VERSION);
	});

	it("registers every real ci.* operation plus Vehicle's approval resolve/status operations", () => {
		const { service } = harness();
		const names = service.vehicle
			.manifest()
			.operations.map((op) => op.name)
			.sort();
		expect(names).toEqual([...OPERATION_NAMES, "vehicle.approval.resolve", "vehicle.approval.status"].sort());
	});

	it("no operation's own schema is itself an action-dispatch blob", () => {
		const { service } = harness();
		for (const op of service.vehicle.manifest().operations) {
			const properties = (op.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
			expect(Object.keys(properties)).not.toContain("action");
		}
	});

	it("gives each action its own honest effect and approval policy", () => {
		const { service } = harness();
		const operation = (name: string) => service.vehicle.manifest().operations.find((candidate) => candidate.name === name);
		expect(operation("ci.status")).toMatchObject({ effect: "read", approvalRequired: false });
		expect(operation("ci.trigger")).toMatchObject({ effect: "external-write", approvalRequired: true });
		expect(operation("ci.cancel")).toMatchObject({ effect: "external-write", approvalRequired: true });
		expect(operation("ci.rerun")).toMatchObject({ effect: "external-write", approvalRequired: true });
		expect(operation("rp.defects.update")).toMatchObject({ effect: "external-write", approvalRequired: true });
		expect(operation("rp.dashboard.create")).toMatchObject({ effect: "external-write", approvalRequired: true });
		expect(operation("rp.dashboard.widget.add")).toMatchObject({ effect: "external-write", approvalRequired: true });
		expect(operation("ci.subscribe")).toMatchObject({ effect: "local-write", approvalRequired: false });
		expect(operation("ci.presets.set")).toMatchObject({ effect: "local-write", approvalRequired: false });
		expect(operation("ci.presets.remove")).toMatchObject({ effect: "local-write", approvalRequired: false });
	});

	it("blocks every external mutation before service dispatch", async () => {
		const calls: string[] = [];
		const registry = createPipesVehicleRegistry({
			execute: async (action: string) => {
				calls.push(action);
				return {};
			},
		} as unknown as PipesService);
		const mutations: Array<[string, Record<string, unknown>]> = [
			["ci.trigger", { backend: "gh", jobRef: "build" }],
			["ci.cancel", { backend: "gh", jobRef: "build", runId: "1" }],
			["ci.rerun", { backend: "gh", jobRef: "build", runId: "1" }],
			["rp.defects.update", { updates: [] }],
			["rp.dashboard.create", { name: "quality" }],
			["rp.dashboard.widget.add", { dashboardId: "1", name: "failures", type: "table" }],
		];

		for (const [name, input] of mutations) {
			await expect(registry.invoke(name, 1, input, PERMS)).rejects.toMatchObject({
				code: "approval-required",
				category: "authorization",
			});
		}
		expect(calls).toEqual([]);
	});

	it("keeps status, logs, discovery, and artifact reads ungated", async () => {
		const calls: string[] = [];
		const registry = createPipesVehicleRegistry({
			execute: async (action: string) => {
				calls.push(action);
				return {};
			},
		} as unknown as PipesService);
		const reads: Array<[string, Record<string, unknown>]> = [
			["ci.status", { backend: "gh", jobRef: "build" }],
			["ci.log", { backend: "gh", jobRef: "build" }],
			["ci.discover", { backend: "gh" }],
			["ci.artifacts", { backend: "gh", jobRef: "build", runId: "1" }],
			["ci.artifact.entries", { backend: "gh", jobRef: "build", runId: "1", path: "logs.zip" }],
			["ci.artifact.text", { backend: "gh", jobRef: "build", runId: "1", path: "logs.zip", entry: "job.log" }],
			["ci.artifact.get", { backend: "gh", jobRef: "build", runId: "1", path: "report.json" }],
		];

		for (const [name, input] of reads) await registry.invoke(name, 1, input, PERMS);
		expect(calls).toEqual(reads.map(([name]) => name));
	});

	it("uses exact-scoped, single-use capabilities for approved mutations", async () => {
		const calls: string[] = [];
		const registry = createPipesVehicleRegistry({
			execute: async (action: string) => {
				calls.push(action);
				return { accepted: true };
			},
		} as unknown as PipesService);
		const input = { backend: "gh", jobRef: "build" };
		const denied = await registry.invoke("ci.trigger", 1, input, PERMS).catch((error: unknown) => error);
		const requestId = (denied as { details?: { requestId?: string } }).details?.requestId;
		expect(typeof requestId).toBe("string");
		await expect(registry.invoke("vehicle.approval.status", 1, { requestId }, {})).resolves.toMatchObject({ status: "pending" });
		const { capability } = (await registry.invoke(
			"vehicle.approval.resolve",
			1,
			{ requestId, decision: "granted" },
			{ permissions: ["vehicle:approvals:resolve"] },
		)) as { capability: string };

		await expect(
			registry.invoke("ci.cancel", 1, { ...input, runId: "1" }, { ...PERMS, approvalCapability: capability }),
		).rejects.toMatchObject({ code: "approval-capability-invalid" });
		await expect(registry.invoke("ci.trigger", 1, input, { ...PERMS, approvalCapability: capability })).resolves.toEqual({
			accepted: true,
		});
		await expect(registry.invoke("ci.trigger", 1, input, { ...PERMS, approvalCapability: capability })).rejects.toMatchObject({
			code: "approval-capability-invalid",
		});
		expect(calls).toEqual(["ci.trigger"]);
	});

	it("ci.subscribe/ci.unsubscribe expose subscriberId (and ci.subscribe's scheduleMs) as optional -- not required, so every existing caller stays valid", () => {
		const { service } = harness();
		const manifest = service.vehicle.manifest();
		const subscribe = manifest.operations.find((op) => op.name === "ci.subscribe");
		const unsubscribe = manifest.operations.find((op) => op.name === "ci.unsubscribe");
		const subscribeSchema = subscribe?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
		const unsubscribeSchema = unsubscribe?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };

		expect(Object.keys(subscribeSchema.properties ?? {})).toEqual(expect.arrayContaining(["subscriberId", "scheduleMs", "runId"]));
		expect(subscribeSchema.required).not.toContain("subscriberId");
		expect(subscribeSchema.required).not.toContain("scheduleMs");
		expect(subscribeSchema.required).not.toContain("runId");
		expect(Object.keys(unsubscribeSchema.properties ?? {})).toEqual(expect.arrayContaining(["subscriberId"]));
		expect(unsubscribeSchema.required).not.toContain("subscriberId");
	});

	it("marks ci.wait streaming and long-running", () => {
		const { service } = harness();
		const wait = service.vehicle.manifest().operations.find((op) => op.name === "ci.wait");
		expect(wait?.streaming).toBe(true);
		expect(wait?.longRunning).toBe(true);
	});

	it("gives ci.wait its own limits wide enough to cover a real long wait, distinct from every other operation's tight cap", () => {
		const { service } = harness();
		const operations = service.vehicle.manifest().operations;
		const wait = operations.find((op) => op.name === "ci.wait");
		// Regression guard for the real bug: ci.wait(timeoutS: 900) against a genuinely still-running
		// GitHub Actions run failed after ~30s with deadline-exceeded, because VehicleRegistry.invoke()'s
		// effectiveDeadline() clamps to limits.maxTimeoutMs regardless of longRunning -- and ci.wait was
		// sharing the generic read-operation LIMITS (30s) that every other operation still uses below.
		expect(wait?.limits.maxTimeoutMs).toBeGreaterThan(30_000);
		expect(wait?.limits.maxTimeoutMs).toBeGreaterThanOrEqual(3_600_000);
		for (const op of operations) {
			if (op.name === "ci.wait" || op.name.startsWith("vehicle.approval.")) continue;
			expect(op.limits.maxTimeoutMs).toBe(30_000);
		}
	});

	it("invoke() delegates to the exact same service.execute() the legacy /api/v1/ops dispatch uses", async () => {
		const { service } = harness();
		const result = (await service.vehicle.invoke("ci.status", 1, { backend: "gh", jobRef: "job" }, PERMS)) as {
			verdict?: unknown;
		};
		expect(result.verdict).toBeDefined();
	});

	it("maps a missing backend to not_found instead of a generic internal failure", async () => {
		const { service } = harness();
		const failure = await service.vehicle
			.invoke("ci.status", 1, { backend: "missing", jobRef: "job" }, PERMS)
			.catch((error: unknown) => error);
		expect((failure as { category?: string }).category).toBe("not_found");
		expect((failure as { code?: string }).code).toBe("operation-rejected");
		expect((failure as Error).message).toContain("missing");
	});

	it("maps a transient backend transport failure separately from an unknown pipeline", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", err: new TypeError("fetch failed: token=secret") }));
		orchestrator.registerPipeline({ name: "lector-ci", backend: "gh", steps: [{ jobName: "build" }] });
		const service = createPipesService(orchestrator);

		const failure = await service.vehicle.invoke("ci.status", 1, { pipeline: "lector-ci" }, PERMS).catch((error: unknown) => error);

		expect(failure).toMatchObject({ category: "unavailable", code: "backend-unavailable" });
		expect((failure as Error).message).toContain('ci.status for pipeline "lector-ci" (backend "gh")');
		expect((failure as Error).message).not.toContain("secret");
	});

	it("returns the same registry instance on repeated access -- built once, not rebuilt per call", () => {
		const { service } = harness();
		expect(service.vehicle).toBe(service.vehicle);
	});

	it("ci.wait streams a progress tick per poll for the jobRef+runId watch form, then resolves with the final status+tail", async () => {
		const { service } = harness();
		const progress: unknown[] = [];
		const result = (await service.vehicle.invoke(
			"ci.wait",
			1,
			{ backend: "gh", jobRef: "job", runId: "1", timeoutS: 5 },
			{ ...PERMS, onProgress: (value: unknown) => progress.push(value) },
		)) as { status: string; tail: unknown };
		expect(result.status).toBe("success");
		expect(result.tail).toBeDefined();
		expect(progress.length).toBeGreaterThan(0);
		expect((progress[0] as { status: string }).status).toBe("success");
	});

	it("ci.wait does not stream progress for the opaqueRef-resolve form -- nothing to tail yet", async () => {
		const { service, orchestrator } = harness();
		const receipt = await orchestrator.ciTrigger("gh", "job", {});
		const progress: unknown[] = [];
		const opaqueRef = (receipt as { queueId?: string }).queueId ?? (receipt as { buildNumber?: string }).buildNumber ?? "1";
		await service.vehicle.invoke(
			"ci.wait",
			1,
			{ backend: "gh", jobRef: "job", opaqueRef },
			{ ...PERMS, onProgress: (value: unknown) => progress.push(value) },
		);
		expect(progress).toHaveLength(0);
	});
});

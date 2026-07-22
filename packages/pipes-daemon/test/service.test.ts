import { describe, expect, it } from "bun:test";
import { Orchestrator } from "../src/orchestrator.ts";
import { Capability } from "../src/ports/ci-backend.ts";
import { createPipesService } from "../src/service.ts";
import { createStubCIBackend } from "./fixtures/stub-ci-backend.ts";

describe("ci.status", () => {
	it("returns a verdict for backend+jobRef", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", run: { id: "1", name: "run", status: "success", startedAt: new Date(0) } }));
		const service = createPipesService(orchestrator);

		const result = await service.execute("ci.status", { backend: "gh", jobRef: "job" });
		expect(result.verdict).toBeDefined();
		expect(result.pipelineRun).toBeUndefined();
	});

	it("returns a pipelineRun when pipeline is given instead of backend/jobRef", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", capabilities: Capability.Trigger, run: { id: "1", name: "run", status: "success", startedAt: new Date(0) } }),
		);
		orchestrator.registerPipeline({ name: "deploy", backend: "gh", steps: [{ jobName: "build" }] });
		const service = createPipesService(orchestrator);

		await service.execute("ci.trigger", { pipeline: "deploy" });
		const result = await service.execute("ci.status", { pipeline: "deploy" });
		expect(result.pipelineRun?.status).toBe("success");
	});

	it("rejects a status call with neither pipeline nor backend/jobRef", async () => {
		const service = createPipesService(new Orchestrator());
		await expect(service.execute("ci.status", {})).rejects.toThrow(/backend and jobRef are required/);
	});
});

describe("ci.trigger", () => {
	it("returns a TriggerResult for a raw backend+jobRef trigger", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", capabilities: Capability.Trigger, triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "7" } }),
		);
		const service = createPipesService(orchestrator);

		const result = await service.execute("ci.trigger", { backend: "gh", jobRef: "job", params: {} });
		expect(result.result?.buildNumber).toBe("7");
	});
});

describe("ci.wait", () => {
	it("resolves immediately once the watched run reaches a terminal status", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", capabilities: Capability.Trigger, run: { id: "1", name: "run", status: "success", startedAt: new Date(0) } }),
		);
		const service = createPipesService(orchestrator, { waitPollIntervalMs: 1 });

		const result = await service.execute("ci.wait", { backend: "gh", jobRef: "job", runId: "1", timeoutS: 5 });
		expect("status" in result && result.status).toBe("success");
	});

	it("polls until timeout and returns the last known status when the run never terminates", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", capabilities: Capability.Trigger, run: { id: "1", name: "run", status: "running", startedAt: new Date(0) } }),
		);
		const service = createPipesService(orchestrator, { waitPollIntervalMs: 5 });

		const start = Date.now();
		const result = await service.execute("ci.wait", { backend: "gh", jobRef: "job", runId: "1", timeoutS: 0.02 });
		expect("status" in result && result.status).toBe("running");
		expect(Date.now() - start).toBeLessThan(1000); // bounded by timeoutS, not left hanging
	});

	it("resolves an opaqueRef without watching a run", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", capabilities: Capability.Trigger, resolvedReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "99" } }),
		);
		const service = createPipesService(orchestrator);

		const result = await service.execute("ci.wait", { backend: "gh", opaqueRef: "queue-1" });
		expect(result).toEqual({ buildNumber: "99" });
	});
});

describe("ci.cancel", () => {
	it("maps NotOwnedError to an HTTP-mappable rejection rather than silently succeeding", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "gh" }));
		const service = createPipesService(orchestrator);

		await expect(service.execute("ci.cancel", { backend: "gh", jobRef: "job", runId: "1" })).rejects.toThrow(/not owned/);
	});

	it("succeeds once the run was triggered through ci.trigger in this session", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", capabilities: Capability.Trigger, triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "7" } }),
		);
		const service = createPipesService(orchestrator);

		await service.execute("ci.trigger", { backend: "gh", jobRef: "job", params: {} });
		const result = await service.execute("ci.cancel", { backend: "gh", jobRef: "job", runId: "7" });
		expect(result).toEqual({ status: "cancelled", runId: "7" });
	});
});

describe("ci.search", () => {
	it("passes filter fields through to the orchestrator, parsing since as a Date", async () => {
		const orchestrator = new Orchestrator();
		const run = { id: "1", name: "run", status: "success" as const, startedAt: new Date("2026-01-01T00:00:00Z") };
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", searchResults: [run] }));
		const service = createPipesService(orchestrator);

		const result = await service.execute("ci.search", { backend: "gh", jobRef: "job", since: "2026-01-01T00:00:00Z" });
		expect(result.builds).toEqual([run]);
	});
});

describe("ci.help", () => {
	it("lists configured backends and registered pipelines", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", capabilities: Capability.Trigger }));
		orchestrator.registerPipeline({ name: "deploy", backend: "gh", steps: [] });
		const service = createPipesService(orchestrator);

		const result = await service.execute("ci.help", {});
		expect(result.backends).toEqual([{ name: "gh", type: "stub", capabilities: "trigger" }]);
		expect(result.pipelines).toEqual(["deploy"]);
	});
});

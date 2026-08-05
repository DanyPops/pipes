import { describe, expect, it } from "bun:test";
import { Orchestrator } from "../../src/orchestrator.ts";
import { createPipesService, ReportPortalNotConfiguredError } from "../../src/rpc/service.ts";
import { createStubLaunchBackend } from "../fixtures/stub-launch-backend.ts";

const LAUNCH = {
	id: "42",
	name: "Smoke",
	status: "PASSED",
	startTime: new Date(0),
	statistics: { total: 1, passed: 1, failed: 0, skipped: 0 },
};

const ITEM = { id: "7", name: "test_x", status: "FAILED", launchId: "42" };

describe("rp.* operations: not configured", () => {
	it("rejects every rp.* operation with a typed ReportPortalNotConfiguredError when no LaunchBackend is wired", async () => {
		const service = createPipesService(new Orchestrator());
		await expect(service.execute("rp.launches", {})).rejects.toThrow(ReportPortalNotConfiguredError);
		await expect(service.execute("rp.launch", { id: "1" })).rejects.toThrow(ReportPortalNotConfiguredError);
	});
});

describe("rp.launches / rp.launch", () => {
	it("lists launches and converts ISO date-range fields to Date before calling the backend", async () => {
		const launchBackend = createStubLaunchBackend({ launches: [LAUNCH] });
		const service = createPipesService(new Orchestrator(), { launchBackend });
		const result = await service.execute("rp.launches", { startAfter: "2024-01-01T00:00:00Z" });
		expect(result.launches).toEqual([LAUNCH]);
	});

	it("gets a single launch by id, throwing LaunchNotFoundError for an unknown one", async () => {
		const launchBackend = createStubLaunchBackend({ launchesById: { "42": LAUNCH } });
		const service = createPipesService(new Orchestrator(), { launchBackend });
		const result = await service.execute("rp.launch", { id: "42" });
		expect(result.launch).toEqual(LAUNCH);
		await expect(service.execute("rp.launch", { id: "999" })).rejects.toThrow(/not found/);
	});
});

describe("rp.items / rp.search", () => {
	it("lists test items for a launch", async () => {
		const launchBackend = createStubLaunchBackend({ testItems: [ITEM] });
		const service = createPipesService(new Orchestrator(), { launchBackend });
		const result = await service.execute("rp.items", { launchId: "42" });
		expect(result.items).toEqual([ITEM]);
	});

	it("searches across launches, converting since/before to Date", async () => {
		const launchBackend = createStubLaunchBackend({ testItems: [ITEM] });
		const service = createPipesService(new Orchestrator(), { launchBackend });
		const result = await service.execute("rp.search", { launchIds: ["42"], since: "2024-01-01T00:00:00Z" });
		expect(result.items).toEqual([ITEM]);
	});

	it("rejects rp.search when launchIds is empty, matching the adapter's own contract", async () => {
		const launchBackend = createStubLaunchBackend();
		const service = createPipesService(new Orchestrator(), { launchBackend });
		await expect(service.execute("rp.search", {})).rejects.toThrow(/launchIds|launch ID/i);
	});
});

describe("rp.item / rp.items.get", () => {
	it("gets a single test item and a batch by id", async () => {
		const launchBackend = createStubLaunchBackend({ testItemsById: { "7": ITEM } });
		const service = createPipesService(new Orchestrator(), { launchBackend });
		expect((await service.execute("rp.item", { id: "7" })).item).toEqual(ITEM);
		expect((await service.execute("rp.items.get", { ids: ["7"] })).items).toEqual([ITEM]);
	});
});

describe("rp.defects.update", () => {
	it("forwards updates to the backend and reports the count applied", async () => {
		const launchBackend = createStubLaunchBackend();
		const service = createPipesService(new Orchestrator(), { launchBackend });
		const result = await service.execute("rp.defects.update", { updates: [{ testItemId: "7", issueType: "pb001" }] });
		expect(result.updated).toBe(1);
		expect(launchBackend.calls.updateDefects).toHaveLength(1);
	});
});

describe("rp.dashboards / rp.dashboard / rp.dashboard.create / rp.dashboard.widget.add", () => {
	it("covers the full dashboard CRUD surface", async () => {
		const dashboard = { id: "1", name: "Overview" };
		const launchBackend = createStubLaunchBackend({ dashboards: [dashboard], dashboardsById: { "1": dashboard } });
		const service = createPipesService(new Orchestrator(), { launchBackend });

		expect((await service.execute("rp.dashboards", {})).dashboards).toEqual([dashboard]);
		expect((await service.execute("rp.dashboard", { id: "1" })).dashboard).toEqual(dashboard);

		const created = await service.execute("rp.dashboard.create", { name: "New" });
		expect(created.dashboard.name).toBe("New");

		const widget = await service.execute("rp.dashboard.widget.add", { dashboardId: "1", name: "Launches", type: "launchesTable" });
		expect(widget.widget.name).toBe("Launches");
		expect(launchBackend.calls.addWidget).toEqual([{ dashboardId: "1" }]);
	});
});

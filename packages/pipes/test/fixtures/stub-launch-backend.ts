/** Configurable fake LaunchBackend for tests, mirroring stub-ci-backend.ts's own options-bag pattern. */

import type { Dashboard, Launch, TestItem, Widget } from "../../src/reportportal/launch.ts";
import { type LaunchBackend, LaunchNotFoundError, TestItemNotFoundError } from "../../src/reportportal/launch-backend.ts";

export interface StubLaunchBackendOptions {
	name?: string;
	launches?: Launch[];
	launchesById?: Record<string, Launch>;
	testItems?: TestItem[];
	testItemsById?: Record<string, TestItem>;
	dashboards?: Dashboard[];
	dashboardsById?: Record<string, Dashboard>;
	createdDashboard?: Dashboard;
	addedWidget?: Widget;
}

export type StubLaunchBackend = LaunchBackend & {
	calls: { updateDefects: unknown[][]; addWidget: Array<{ dashboardId: string }> };
};

export function createStubLaunchBackend(options: StubLaunchBackendOptions = {}): StubLaunchBackend {
	const name = options.name ?? "stub-reportportal";
	const calls: StubLaunchBackend["calls"] = { updateDefects: [], addWidget: [] };

	return {
		name: () => name,
		calls,
		listLaunches: async () => options.launches ?? [],
		getLaunch: async (id) => {
			const launch = options.launchesById?.[id];
			if (!launch) throw new LaunchNotFoundError(id);
			return launch;
		},
		listTestItems: async () => options.testItems ?? [],
		searchTestItems: async (filter) => {
			if (!filter.launchIds || filter.launchIds.length === 0) {
				throw new Error(
					"searchTestItems requires at least one launch ID; set launchName/since/before so the caller can resolve them first",
				);
			}
			return options.testItems ?? [];
		},
		getTestItem: async (id) => {
			const item = options.testItemsById?.[id];
			if (!item) throw new TestItemNotFoundError(id);
			return item;
		},
		getTestItems: async (ids) => ids.map((id) => options.testItemsById?.[id]).filter((item): item is TestItem => item !== undefined),
		updateDefects: async (updates) => {
			calls.updateDefects.push(updates);
		},
		listDashboards: async () => options.dashboards ?? [],
		getDashboard: async (id) => {
			const dashboard = options.dashboardsById?.[id];
			if (!dashboard) throw new Error(`dashboard not found: ${id}`);
			return dashboard;
		},
		createDashboard: async (input) => options.createdDashboard ?? { id: "1", name: input.name, description: input.description },
		addWidget: async (dashboardId, input) => {
			calls.addWidget.push({ dashboardId });
			return options.addedWidget ?? { id: "1", name: input.name, type: input.type };
		},
	};
}

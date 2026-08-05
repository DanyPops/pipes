/**
 * Outbound port for Report Portal launch/test-item/dashboard queries.
 * Deliberately NOT part of CIBackend -- Report Portal launches are
 * test-execution results, a different domain than CIBackend's
 * run/trigger/log/artifact/stage concepts. A sibling port, co-located
 * with its own domain types (launch.ts) rather than filed under the
 * generic run/ bucket.
 */
import type {
	Dashboard,
	DashboardCreateInput,
	DefectUpdate,
	Launch,
	LaunchFilter,
	TestItem,
	TestItemFilter,
	Widget,
	WidgetAddInput,
} from "./launch.ts";

export class LaunchNotFoundError extends Error {
	constructor(id: string) {
		super(`Report Portal: launch not found: ${id}`);
	}
}

export class TestItemNotFoundError extends Error {
	constructor(id: string) {
		super(`Report Portal: test item not found: ${id}`);
	}
}

export interface LaunchBackend {
	name(): string;
	listLaunches(filter: LaunchFilter): Promise<Launch[]>;
	getLaunch(id: string): Promise<Launch>;
	listTestItems(launchId: string, filter: TestItemFilter): Promise<TestItem[]>;
	/** Cross-launch search. Rejects if filter.launchIds is empty -- the caller must resolve launchName/since/before into launchIds first (RP's /item endpoint 400s without at least one filter.in.launchId). */
	searchTestItems(filter: TestItemFilter): Promise<TestItem[]>;
	getTestItem(id: string): Promise<TestItem>;
	getTestItems(ids: string[]): Promise<TestItem[]>;
	updateDefects(updates: DefectUpdate[]): Promise<void>;
	listDashboards(): Promise<Dashboard[]>;
	getDashboard(id: string): Promise<Dashboard>;
	createDashboard(input: DashboardCreateInput): Promise<Dashboard>;
	addWidget(dashboardId: string, input: WidgetAddInput): Promise<Widget>;
}

/**
 * Report Portal domain types: test-execution results (launches, test items,
 * dashboards), a different domain than run/ci-run.ts's CI-run/trigger
 * concepts. Plain data shapes only -- RP's own wire format (numeric ids,
 * nested `statistics.executions`, epoch-millis-or-ISO-string timestamps) is
 * owned entirely by the adapter (reportportal.ts) and mapped in at that
 * boundary, never leaked here.
 */

export interface LaunchAttribute {
	key: string;
	value: string;
}

export interface LaunchStatistics {
	total: number;
	passed: number;
	failed: number;
	skipped: number;
	defects?: Record<string, number>;
}

export interface Launch {
	id: string;
	name: string;
	status: string;
	description?: string;
	owner?: string;
	startTime: Date;
	endTime?: Date;
	statistics: LaunchStatistics;
	attributes?: LaunchAttribute[];
	url?: string;
}

export interface LaunchFilter {
	name?: string;
	status?: string;
	/** List launches that started after this time. */
	startAfter?: Date;
	/** List launches that started before this time. */
	startBefore?: Date;
	/** Exact attribute key=value filters (e.g. "ci-lane"="telco-ft-ran-ptp"). */
	attributes?: Record<string, string>;
	limit?: number;
	/** 0-based page number for pagination. */
	page?: number;
}

export interface ExternalSystemIssue {
	ticketId: string;
	btsUrl: string;
	btsProject: string;
	url?: string;
}

export interface TestItem {
	id: string;
	name: string;
	status: string;
	type?: string;
	parentId?: string;
	launchId: string;
	issueType?: string;
	comment?: string;
	failureMessage?: string;
	externalSystemIssues?: ExternalSystemIssue[];
	url?: string;
}

export interface TestItemFilter {
	/** Substring filter on test item name. */
	name?: string;
	/** FAILED | PASSED | SKIPPED -- one or more. */
	status?: string[];
	/** ti001 | pb001 | ab001 -- one or more. */
	issueType?: string[];
	type?: string;
	limit?: number;
	/** 0-based page number for pagination. */
	page?: number;
	/** Fetch failureMessage for FAILED items. */
	includeLogs?: boolean;
	/** Include suite/container nodes (hasChildren=true); required for a tree view. */
	includeSuites?: boolean;

	// Cross-launch search fields. The application layer resolves launchName/since/before
	// into launchIds before calling searchTestItems.
	/** Resolved by the application layer. */
	launchIds?: string[];
	/** Launch name substring filter. */
	launchName?: string;
	/** Exact attribute filters (e.g. "ci-lane"="telco-ft-ran-ptp"). */
	launchAttributes?: Record<string, string>;
	/** Launch start time lower bound. */
	since?: Date;
	/** Launch start time upper bound. */
	before?: Date;
}

export interface Widget {
	id: string;
	name: string;
	type: string;
	width?: number;
	height?: number;
}

export interface Dashboard {
	id: string;
	name: string;
	description?: string;
	widgets?: Widget[];
}

export interface DashboardCreateInput {
	name: string;
	description?: string;
}

export interface WidgetAddInput {
	name: string;
	type: string;
	width?: number;
	height?: number;
}

export interface DefectUpdate {
	testItemId: string;
	issueType: string;
	comment?: string;
	externalSystemIssues?: ExternalSystemIssue[];
}

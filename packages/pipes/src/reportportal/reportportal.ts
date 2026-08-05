/**
 * Report Portal REST API v1 adapter -- a driven (outbound) LaunchBackend
 * implementation. Constructing this performs no network I/O -- connectivity
 * is only ever exercised by the first real operation call.
 */

import type { FetchLike } from "../auth/github-auth.ts";
import { parseRateLimitHeaders, parseRetryAfterMs, RateLimitError } from "../http/rate-limit.ts";
import { withTimeout } from "../http/timeout.ts";
import type {
	Dashboard,
	DashboardCreateInput,
	DefectUpdate,
	ExternalSystemIssue,
	Launch,
	LaunchFilter,
	TestItem,
	TestItemFilter,
	Widget,
	WidgetAddInput,
} from "./launch.ts";
import { type LaunchBackend, LaunchNotFoundError, TestItemNotFoundError } from "./launch-backend.ts";

const DEFAULT_LIMIT = 50;
const STATUS_FAILED = "FAILED";

export class ReportPortalApiError extends Error {
	constructor(method: string, path: string, status: number, body: string) {
		super(`Report Portal API error: ${method} ${path}: ${status}: ${body}`);
	}
}

export interface ReportPortalAdapterOptions {
	name: string;
	baseUrl: string;
	project: string;
	token?: string;
	/** Resolved fresh before every request; takes precedence over `token` when present so a rotated/refreshed credential is always picked up. */
	getToken?: () => Promise<string | undefined>;
	fetchImpl?: FetchLike;
}

export function createReportPortalAdapter(options: ReportPortalAdapterOptions): LaunchBackend {
	const { name, project, token } = options;
	const baseUrl = options.baseUrl.replace(/\/+$/, "");
	// A caller-supplied fetchImpl (tests, or a future custom transport) is used as-is; the real
	// default fetch is wrapped so a stalled connection to Report Portal can't hang a caller forever.
	const doFetch = options.fetchImpl ?? withTimeout();
	const resolveToken = options.getToken ?? (async () => token);

	async function api<T>(method: string, path: string, body?: unknown, notFound?: (path: string) => Error): Promise<T> {
		const bearer = await resolveToken();
		const response = await doFetch(`${baseUrl}/api/v1/${project}${path}`, {
			method,
			headers: {
				...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
				"content-type": "application/json",
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});

		if (response.status === 404) throw (notFound ?? ((p: string) => new LaunchNotFoundError(p)))(path);
		if (response.status === 429) {
			const info = parseRateLimitHeaders(response.headers);
			throw new RateLimitError(name, parseRetryAfterMs(response.headers.get("retry-after")), info);
		}
		if (!response.ok) {
			const text = await response.text();
			throw new ReportPortalApiError(method, path, response.status, text);
		}
		const text = await response.text();
		return (text ? JSON.parse(text) : undefined) as T;
	}

	async function fetchErrorLogs(itemId: string): Promise<string> {
		// Built as a literal string, not URLSearchParams: filter.in.level must appear as two
		// REPEATED params (RP rejects a single comma-joined value here), and RP rejects a sort
		// param on this endpoint specifically -- unlike every other endpoint here, none is added.
		const path = `/log?filter.eq.item=${itemId}&filter.in.level=ERROR&filter.in.level=TRACE&page.size=10`;
		const result = await api<{ content?: RpLogEntry[] }>("GET", path);
		const entries = result.content ?? [];
		return entries.map((entry) => entry.message).join("\n");
	}

	async function toDomainWithLogs(raw: RpTestItem, includeLogs: boolean | undefined): Promise<TestItem> {
		const item = rpTestItemToDomain(raw, baseUrl, project);
		if (includeLogs && item.status === STATUS_FAILED) {
			item.failureMessage = await fetchErrorLogs(item.id);
		}
		return item;
	}

	return {
		name: () => name,

		async listLaunches(filter: LaunchFilter): Promise<Launch[]> {
			const limit = filter.limit && filter.limit > 0 ? filter.limit : DEFAULT_LIMIT;
			const page = filter.page && filter.page > 0 ? filter.page : 0;
			const params = new URLSearchParams({ "page.size": String(limit), "page.number": String(page), "page.sort": "startTime,desc" });
			if (filter.name) params.set("filter.cnt.name", filter.name);
			if (filter.status) params.set("filter.eq.status", filter.status.toUpperCase());
			for (const [key, value] of Object.entries(filter.attributes ?? {})) {
				params.append("filter.has.compositeAttribute", `${key}:${value}`);
			}
			if (filter.startAfter || filter.startBefore) {
				const after = filter.startAfter ? filter.startAfter.getTime() : 0;
				const before = filter.startBefore ? filter.startBefore.getTime() : 0;
				params.set("filter.btw.startTime", `${after},${before}`);
			}

			const result = await api<{ content: RpLaunch[] }>("GET", `/launch?${params}`);
			return result.content.map((raw) => rpLaunchToDomain(raw, baseUrl, project));
		},

		async getLaunch(id: string): Promise<Launch> {
			const raw = await api<RpLaunch>("GET", `/launch/${id}`, undefined, () => new LaunchNotFoundError(id));
			return rpLaunchToDomain(raw, baseUrl, project);
		},

		async listTestItems(launchId: string, filter: TestItemFilter): Promise<TestItem[]> {
			const params = buildTestItemParams(filter);
			params.set("filter.eq.launchId", launchId);
			const result = await api<{ content: RpTestItem[] }>("GET", `/item?${params}`);
			return Promise.all(result.content.map((raw) => toDomainWithLogs(raw, filter.includeLogs)));
		},

		async searchTestItems(filter: TestItemFilter): Promise<TestItem[]> {
			if (!filter.launchIds || filter.launchIds.length === 0) {
				throw new Error(
					"Report Portal: searchTestItems requires at least one launch ID; set launchName/since/before so the caller can resolve them first",
				);
			}
			const params = buildTestItemParams(filter);
			// RP requires a literal comma list here -- URLSearchParams would percent-encode the
			// commas to %2C, which RP's filter.in.* rejects. Built as a manual path segment instead.
			const path = `/item?filter.in.launchId=${filter.launchIds.join(",")}&${params}`;
			const result = await api<{ content: RpTestItem[] }>("GET", path);
			return Promise.all(result.content.map((raw) => toDomainWithLogs(raw, filter.includeLogs)));
		},

		async getTestItem(id: string): Promise<TestItem> {
			const raw = await api<RpTestItem>("GET", `/item/${id}`, undefined, () => new TestItemNotFoundError(id));
			return toDomainWithLogs(raw, true);
		},

		async getTestItems(ids: string[]): Promise<TestItem[]> {
			// Literal comma list, matching filter.in.launchId's own wire-format constraint.
			const path = `/item?filter.in.id=${ids.join(",")}&page.size=${ids.length}`;
			const result = await api<{ content: RpTestItem[] }>("GET", path);
			return Promise.all(result.content.map((raw) => toDomainWithLogs(raw, true)));
		},

		async updateDefects(updates: DefectUpdate[]): Promise<void> {
			const issues = updates.map((update) => ({
				testItemId: Number(update.testItemId),
				issue: {
					issueType: update.issueType,
					...(update.comment ? { comment: update.comment } : {}),
					...(update.externalSystemIssues ? { externalSystemIssues: update.externalSystemIssues.map(toWireIssue) } : {}),
				},
			}));
			// Always PUT the bulk /item endpoint, never PUT /item/{id}/update -- Report Portal
			// accepts (and this adapter always uses) the bulk form even for a single update.
			await api<undefined>("PUT", "/item", { issues });
		},

		async listDashboards(): Promise<Dashboard[]> {
			const result = await api<{ content: RpDashboard[] }>("GET", "/dashboard");
			return result.content.map(rpDashboardToDomain);
		},

		async getDashboard(id: string): Promise<Dashboard> {
			const raw = await api<RpDashboard>("GET", `/dashboard/${id}`);
			return rpDashboardToDomain(raw);
		},

		async createDashboard(input: DashboardCreateInput): Promise<Dashboard> {
			const result = await api<{ id: number }>("POST", "/dashboard", { name: input.name, description: input.description });
			return { id: String(result.id), name: input.name, description: input.description };
		},

		async addWidget(dashboardId: string, input: WidgetAddInput): Promise<Widget> {
			const body = { name: input.name, widgetType: input.type, widgetSize: { width: input.width, height: input.height } };
			const result = await api<{ id: number }>("POST", `/dashboard/${dashboardId}/widget`, body);
			return { id: String(result.id), name: input.name, type: input.type };
		},
	};
}

/** Shared between listTestItems and searchTestItems -- everything except launchId/filter.in.launchId, which each caller sets on its own terms. */
function buildTestItemParams(filter: TestItemFilter): URLSearchParams {
	const limit = filter.limit && filter.limit > 0 ? filter.limit : DEFAULT_LIMIT;
	const page = filter.page && filter.page > 0 ? filter.page : 0;
	const params = new URLSearchParams({
		isLatest: "false",
		launchesLimit: "0",
		"page.size": String(limit),
		"page.number": String(page),
	});
	if (!filter.includeSuites) params.set("filter.eq.hasChildren", "false");
	if (filter.status && filter.status.length > 0) params.set("filter.in.status", filter.status.map((s) => s.toUpperCase()).join(","));
	if (filter.issueType && filter.issueType.length > 0) params.set("filter.in.issueType", filter.issueType.join(","));
	if (filter.name) params.set("filter.cnt.name", filter.name);
	return params;
}

function toWireIssue(issue: ExternalSystemIssue) {
	return { ticketId: issue.ticketId, btsUrl: issue.btsUrl, btsProject: issue.btsProject, ...(issue.url ? { url: issue.url } : {}) };
}

// --- Wire-format DTOs + mapping (RP's own JSON shape, never leaked past this file) ---

interface RpLaunch {
	id: number;
	name: string;
	status: string;
	description?: string;
	owner?: string;
	startTime?: number | string | null;
	endTime?: number | string | null;
	attributes?: { key: string; value: string }[];
	statistics: {
		executions: { total: number; passed: number; failed: number; skipped: number };
		defects?: Record<string, { total: number }>;
	};
}

interface RpTestItemIssue {
	issueType: string;
	comment?: string;
	externalSystemIssues?: { ticketId: string; btsUrl: string; btsProject: string; url?: string }[];
}

interface RpTestItem {
	id: number;
	name: string;
	status: string;
	type?: string;
	parent?: number;
	launchId: number;
	issue?: RpTestItemIssue;
}

interface RpLogEntry {
	id: number;
	message: string;
	level: string;
}

interface RpDashboard {
	id: number;
	name: string;
	description?: string;
}

/**
 * Handles both epoch-millis (number) and ISO 8601 (string, with or without
 * milliseconds) formats -- RP emits either depending on endpoint/version.
 * Returns undefined (never throws) for null/empty/unparseable input.
 */
export function parseRpTimestamp(raw: number | string | null | undefined): Date | undefined {
	if (raw === null || raw === undefined || raw === "") return undefined;
	if (typeof raw === "number") {
		return raw > 0 ? new Date(raw) : undefined;
	}
	const parsed = new Date(raw);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function rpLaunchToDomain(raw: RpLaunch, baseUrl: string, project: string): Launch {
	const defects: Record<string, number> = {};
	for (const [category, counts] of Object.entries(raw.statistics.defects ?? {})) {
		defects[category] = counts.total;
	}
	return {
		id: String(raw.id),
		name: raw.name,
		status: raw.status,
		description: raw.description,
		owner: raw.owner,
		startTime: parseRpTimestamp(raw.startTime) ?? new Date(0),
		endTime: parseRpTimestamp(raw.endTime),
		statistics: {
			total: raw.statistics.executions.total,
			passed: raw.statistics.executions.passed,
			failed: raw.statistics.executions.failed,
			skipped: raw.statistics.executions.skipped,
			...(Object.keys(defects).length > 0 ? { defects } : {}),
		},
		attributes: raw.attributes?.map((a) => ({ key: a.key, value: a.value })),
		url: `${baseUrl}/ui/#${project}/launches/all/${raw.id}`,
	};
}

export function rpTestItemToDomain(raw: RpTestItem, baseUrl: string, project: string): TestItem {
	return {
		id: String(raw.id),
		name: raw.name,
		status: raw.status,
		type: raw.type,
		parentId: raw.parent ? String(raw.parent) : undefined,
		launchId: String(raw.launchId),
		issueType: raw.issue?.issueType,
		comment: raw.issue?.comment,
		externalSystemIssues: raw.issue?.externalSystemIssues?.map((esi) => ({
			ticketId: esi.ticketId,
			btsUrl: esi.btsUrl,
			btsProject: esi.btsProject,
			url: esi.url,
		})),
		url: `${baseUrl}/ui/#${project}/launches/all/${raw.launchId}`,
	};
}

function rpDashboardToDomain(raw: RpDashboard): Dashboard {
	return { id: String(raw.id), name: raw.name, description: raw.description };
}

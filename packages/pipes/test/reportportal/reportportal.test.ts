import { describe, expect, it } from "bun:test";
import type { FetchLike } from "../../src/auth/github-auth.ts";
import { RateLimitError } from "../../src/http/rate-limit.ts";
import { LaunchNotFoundError, TestItemNotFoundError } from "../../src/reportportal/launch-backend.ts";
import {
	createReportPortalAdapter,
	parseRpTimestamp,
	ReportPortalApiError,
	rpLaunchToDomain,
	rpTestItemToDomain,
} from "../../src/reportportal/reportportal.ts";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

describe("createReportPortalAdapter: construction performs no network I/O", () => {
	it("never calls fetch until an operation is invoked", () => {
		const fetchImpl: FetchLike = () => {
			throw new Error("fetch must not be called during construction");
		};
		expect(() =>
			createReportPortalAdapter({ name: "rp", baseUrl: "https://rp.example.com", project: "myproject", token: "t", fetchImpl }),
		).not.toThrow();
	});
});

describe("createReportPortalAdapter: baseUrl trailing slash is trimmed", () => {
	it("does not double a slash when baseUrl ends with one", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse({ content: [] });
		};
		const adapter = createReportPortalAdapter({
			name: "rp",
			baseUrl: "https://rp.example.com/",
			project: "myproject",
			token: "t",
			fetchImpl,
		});
		await adapter.listLaunches({});
		expect(requestedUrl.startsWith("https://rp.example.com/api/v1/")).toBe(true);
		expect(requestedUrl).not.toContain("//api");
	});
});

describe("createReportPortalAdapter.name", () => {
	it("returns the configured name", () => {
		const adapter = createReportPortalAdapter({ name: "rp", baseUrl: "https://rp.example.com", project: "p", token: "t" });
		expect(adapter.name()).toBe("rp");
	});
});

describe("parseRpTimestamp", () => {
	it("parses epoch millis", () => {
		// 1711400000000 = 2024-03-25T22:13:20Z
		const got = parseRpTimestamp(1711400000000);
		expect(got).toBeDefined();
		expect(got?.getTime()).toBe(1711400000000);
	});

	it("parses an ISO 8601 string", () => {
		const got = parseRpTimestamp("2024-03-25T22:13:20Z");
		expect(got).toBeDefined();
		expect(got?.toISOString()).toBe("2024-03-25T22:13:20.000Z");
	});

	it("parses an ISO 8601 string with milliseconds", () => {
		const got = parseRpTimestamp("2024-03-25T22:13:20.123Z");
		expect(got).toBeDefined();
		expect(got?.getUTCMilliseconds()).toBe(123);
	});

	it("returns undefined for null, no throw", () => {
		expect(() => parseRpTimestamp(null)).not.toThrow();
		expect(parseRpTimestamp(null)).toBeUndefined();
	});

	it("returns undefined for empty, no throw", () => {
		expect(() => parseRpTimestamp("")).not.toThrow();
		expect(parseRpTimestamp("")).toBeUndefined();
	});

	it("returns undefined for an invalid string, no throw", () => {
		expect(() => parseRpTimestamp("not-a-date")).not.toThrow();
		expect(parseRpTimestamp("not-a-date")).toBeUndefined();
	});
});

describe("rpLaunchToDomain", () => {
	it("maps executions + defects, and builds the launch URL", () => {
		const raw = {
			id: 42,
			name: "Smoke Test",
			status: "PASSED",
			description: "nightly run",
			owner: "ci-bot",
			startTime: 1711400000000,
			endTime: null,
			statistics: {
				executions: { total: 100, passed: 95, failed: 3, skipped: 2 },
				defects: { product_bug: { total: 2 }, automation_bug: { total: 1 } },
			},
		};
		const got = rpLaunchToDomain(raw, "https://rp.example.com", "myproject");
		expect(got.id).toBe("42");
		expect(got.name).toBe("Smoke Test");
		expect(got.statistics.total).toBe(100);
		expect(got.statistics.defects?.product_bug).toBe(2);
		expect(got.statistics.defects?.automation_bug).toBe(1);
		expect(got.url).toBe("https://rp.example.com/ui/#myproject/launches/all/42");
	});
});

describe("rpTestItemToDomain", () => {
	it("maps issue fields when an issue is present", () => {
		const raw = {
			id: 99,
			name: "test_login",
			status: "FAILED",
			type: "STEP",
			launchId: 42,
			issue: { issueType: "pb001", comment: "product bug" },
		};
		const got = rpTestItemToDomain(raw, "https://rp.example.com", "myproject");
		expect(got.id).toBe("99");
		expect(got.issueType).toBe("pb001");
		expect(got.comment).toBe("product bug");
	});

	it("leaves issueType/comment empty, no throw, when there is no issue", () => {
		const raw = { id: 100, name: "test_passing", status: "PASSED", type: "STEP", launchId: 42 };
		expect(() => rpTestItemToDomain(raw, "https://rp.example.com", "myproject")).not.toThrow();
		const got = rpTestItemToDomain(raw, "https://rp.example.com", "myproject");
		expect(got.issueType).toBeUndefined();
		expect(got.comment).toBeUndefined();
	});
});

describe("createReportPortalAdapter.listLaunches", () => {
	it("builds page.size/page.number/page.sort plus name/status/attribute/date-range filters", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse({ content: [] });
		};
		const adapter = createReportPortalAdapter({ name: "rp", baseUrl: "https://rp.example.com", project: "p", token: "t", fetchImpl });

		await adapter.listLaunches({
			name: "smoke",
			status: "failed",
			attributes: { "ci-lane": "telco-ft-ran-ptp" },
			startAfter: new Date(1000),
			startBefore: new Date(2000),
			limit: 25,
			page: 2,
		});

		expect(requestedUrl).toContain("page.size=25");
		expect(requestedUrl).toContain("page.number=2");
		expect(requestedUrl).toContain("page.sort=startTime%2Cdesc");
		expect(requestedUrl).toContain("filter.cnt.name=smoke");
		expect(requestedUrl).toContain("filter.eq.status=FAILED");
		expect(requestedUrl).toContain("filter.has.compositeAttribute=ci-lane%3Atelco-ft-ran-ptp");
		expect(requestedUrl).toContain("filter.btw.startTime=1000%2C2000");
	});

	it("defaults page.size to 50 and page.number to 0 when unset", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse({ content: [] });
		};
		const adapter = createReportPortalAdapter({ name: "rp", baseUrl: "https://rp.example.com", project: "p", token: "t", fetchImpl });
		await adapter.listLaunches({});
		expect(requestedUrl).toContain("page.size=50");
		expect(requestedUrl).toContain("page.number=0");
	});
});

describe("createReportPortalAdapter.getLaunch", () => {
	it("GETs /launch/:id and maps the result", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse({
				id: 42,
				name: "Smoke",
				status: "PASSED",
				statistics: { executions: { total: 1, passed: 1, failed: 0, skipped: 0 } },
			});
		};
		const adapter = createReportPortalAdapter({ name: "rp", baseUrl: "https://rp.example.com", project: "p", token: "t", fetchImpl });
		const launch = await adapter.getLaunch("42");
		expect(requestedUrl).toContain("/launch/42");
		expect(launch.id).toBe("42");
	});

	it("throws a typed LaunchNotFoundError, not a bare Error, on 404", async () => {
		const fetchImpl: FetchLike = async () => new Response("", { status: 404 });
		const adapter = createReportPortalAdapter({ name: "rp", baseUrl: "https://rp.example.com", project: "p", token: "t", fetchImpl });
		await expect(adapter.getLaunch("999")).rejects.toThrow(LaunchNotFoundError);
	});
});

describe("createReportPortalAdapter.listTestItems", () => {
	it("sets filter.eq.launchId, isLatest=false, launchesLimit=0, and filter.eq.hasChildren=false by default", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse({ content: [] });
		};
		const adapter = createReportPortalAdapter({ name: "rp", baseUrl: "https://rp.example.com", project: "p", token: "t", fetchImpl });
		await adapter.listTestItems("42", {});
		expect(requestedUrl).toContain("filter.eq.launchId=42");
		expect(requestedUrl).toContain("isLatest=false");
		expect(requestedUrl).toContain("launchesLimit=0");
		expect(requestedUrl).toContain("filter.eq.hasChildren=false");
	});

	it("omits filter.eq.hasChildren=false when includeSuites is set, including suite/container items in the result", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse({
				content: [{ id: 1, name: "suite", status: "PASSED", type: "SUITE", launchId: 42 }],
			});
		};
		const adapter = createReportPortalAdapter({ name: "rp", baseUrl: "https://rp.example.com", project: "p", token: "t", fetchImpl });
		const items = await adapter.listTestItems("42", { includeSuites: true });
		expect(requestedUrl).not.toContain("filter.eq.hasChildren=false");
		expect(items).toHaveLength(1);
		expect(items[0]?.type).toBe("SUITE");
	});

	it("comma-joins status and issueType lists, uppercasing status", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse({ content: [] });
		};
		const adapter = createReportPortalAdapter({ name: "rp", baseUrl: "https://rp.example.com", project: "p", token: "t", fetchImpl });
		await adapter.listTestItems("42", { status: ["failed", "passed"], issueType: ["pb001", "ti001"] });
		expect(requestedUrl).toContain("filter.in.status=FAILED%2CPASSED");
		expect(requestedUrl).toContain("filter.in.issueType=pb001%2Cti001");
	});

	it("fetches error logs and populates failureMessage for a FAILED item when includeLogs is set", async () => {
		const calls: string[] = [];
		const fetchImpl: FetchLike = async (url) => {
			calls.push(url);
			if (url.includes("/item?")) {
				return jsonResponse({ content: [{ id: 7, name: "test_x", status: "FAILED", launchId: 42 }] });
			}
			if (url.includes("/log?")) {
				return jsonResponse({ content: [{ id: 1, message: "boom", level: "ERROR" }] });
			}
			throw new Error(`unexpected url: ${url}`);
		};
		const adapter = createReportPortalAdapter({ name: "rp", baseUrl: "https://rp.example.com", project: "p", token: "t", fetchImpl });
		const items = await adapter.listTestItems("42", { includeLogs: true });
		expect(items[0]?.failureMessage).toBe("boom");
		expect(calls.some((u) => u.includes("/log?"))).toBe(true);
	});
});

describe("createReportPortalAdapter.searchTestItems", () => {
	it("rejects synchronously when filter.launchIds is empty, telling the caller to resolve launchName/since/before first", async () => {
		const adapter = createReportPortalAdapter({ name: "rp", baseUrl: "https://rp.example.com", project: "p", token: "t" });
		await expect(adapter.searchTestItems({})).rejects.toThrow(/launchName|since|before/i);
	});

	it("includes filter.in.launchId as a literal comma-joined string, never percent-encoded", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse({ content: [] });
		};
		const adapter = createReportPortalAdapter({ name: "rp", baseUrl: "https://rp.example.com", project: "p", token: "t", fetchImpl });
		await adapter.searchTestItems({ launchIds: ["1", "2", "3"] });
		expect(requestedUrl).toContain("filter.in.launchId=1,2,3");
		expect(requestedUrl).not.toContain("filter.in.launchId=1%2C2%2C3");
	});
});

describe("createReportPortalAdapter.getTestItem / getTestItems", () => {
	it("GETs /item/:id", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse({ id: 5, name: "x", status: "PASSED", launchId: 1 });
		};
		const adapter = createReportPortalAdapter({ name: "rp", baseUrl: "https://rp.example.com", project: "p", token: "t", fetchImpl });
		const item = await adapter.getTestItem("5");
		expect(requestedUrl).toContain("/item/5");
		expect(item.id).toBe("5");
	});

	it("throws a typed TestItemNotFoundError, not LaunchNotFoundError, on 404", async () => {
		const fetchImpl: FetchLike = async () => new Response("", { status: 404 });
		const adapter = createReportPortalAdapter({ name: "rp", baseUrl: "https://rp.example.com", project: "p", token: "t", fetchImpl });
		await expect(adapter.getTestItem("999")).rejects.toThrow(TestItemNotFoundError);
	});

	it("GetTestItems fetches by filter.in.id", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse({ content: [{ id: 1, name: "a", status: "PASSED", launchId: 1 }] });
		};
		const adapter = createReportPortalAdapter({ name: "rp", baseUrl: "https://rp.example.com", project: "p", token: "t", fetchImpl });
		const items = await adapter.getTestItems(["1", "2"]);
		expect(requestedUrl).toContain("filter.in.id=1,2");
		expect(items).toHaveLength(1);
	});
});

describe("createReportPortalAdapter: fetchErrorLogs wire format (via includeLogs)", () => {
	it("sends filter.in.level as two repeated params, not comma-joined, and never adds a sort param", async () => {
		let logUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			if (url.includes("/item?")) return jsonResponse({ content: [{ id: 7, name: "x", status: "FAILED", launchId: 1 }] });
			if (url.includes("/log?")) {
				logUrl = url;
				return jsonResponse({ content: [] });
			}
			throw new Error(`unexpected url: ${url}`);
		};
		const adapter = createReportPortalAdapter({ name: "rp", baseUrl: "https://rp.example.com", project: "p", token: "t", fetchImpl });
		await adapter.listTestItems("1", { includeLogs: true });
		expect(logUrl).toContain("filter.in.level=ERROR");
		expect(logUrl).toContain("filter.in.level=TRACE");
		expect(logUrl.match(/filter\.in\.level=/g)).toHaveLength(2);
		expect(logUrl).not.toContain("sort");
	});
});

describe("createReportPortalAdapter.updateDefects", () => {
	it("always PUTs the bulk /item endpoint, never /item/:id/update", async () => {
		let method = "";
		let path = "";
		let body: unknown;
		const fetchImpl: FetchLike = async (url, init) => {
			method = init?.method ?? "GET";
			path = url;
			body = init?.body ? JSON.parse(init.body as string) : undefined;
			return jsonResponse({});
		};
		const adapter = createReportPortalAdapter({ name: "rp", baseUrl: "https://rp.example.com", project: "p", token: "t", fetchImpl });
		await adapter.updateDefects([{ testItemId: "5", issueType: "pb001", comment: "known bug" }]);

		expect(method).toBe("PUT");
		expect(path).toContain("/item");
		expect(path).not.toContain("/item/5/update");
		expect(body).toEqual({ issues: [{ testItemId: 5, issue: { issueType: "pb001", comment: "known bug" } }] });
	});
});

describe("createReportPortalAdapter: dashboards", () => {
	it("listDashboards GETs /dashboard", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse({ content: [{ id: 1, name: "Overview" }] });
		};
		const adapter = createReportPortalAdapter({ name: "rp", baseUrl: "https://rp.example.com", project: "p", token: "t", fetchImpl });
		const dashboards = await adapter.listDashboards();
		expect(requestedUrl).toContain("/dashboard");
		expect(dashboards[0]?.name).toBe("Overview");
	});

	it("getDashboard GETs /dashboard/:id", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchLike = async (url) => {
			requestedUrl = url;
			return jsonResponse({ id: 1, name: "Overview" });
		};
		const adapter = createReportPortalAdapter({ name: "rp", baseUrl: "https://rp.example.com", project: "p", token: "t", fetchImpl });
		const dashboard = await adapter.getDashboard("1");
		expect(requestedUrl).toContain("/dashboard/1");
		expect(dashboard.id).toBe("1");
	});

	it("createDashboard POSTs /dashboard", async () => {
		let method = "";
		let path = "";
		const fetchImpl: FetchLike = async (url, init) => {
			method = init?.method ?? "GET";
			path = url;
			return jsonResponse({ id: 9 });
		};
		const adapter = createReportPortalAdapter({ name: "rp", baseUrl: "https://rp.example.com", project: "p", token: "t", fetchImpl });
		const dashboard = await adapter.createDashboard({ name: "New", description: "desc" });
		expect(method).toBe("POST");
		expect(path).toContain("/dashboard");
		expect(dashboard.id).toBe("9");
		expect(dashboard.name).toBe("New");
	});

	it("addWidget POSTs /dashboard/:id/widget", async () => {
		let path = "";
		const fetchImpl: FetchLike = async (url) => {
			path = url;
			return jsonResponse({ id: 3 });
		};
		const adapter = createReportPortalAdapter({ name: "rp", baseUrl: "https://rp.example.com", project: "p", token: "t", fetchImpl });
		const widget = await adapter.addWidget("9", { name: "Launches", type: "launchesTable", width: 4, height: 2 });
		expect(path).toContain("/dashboard/9/widget");
		expect(widget.id).toBe("3");
	});
});

describe("createReportPortalAdapter: error handling", () => {
	it("throws RateLimitError on 429 with the parsed retry-after", async () => {
		const fetchImpl: FetchLike = async () => new Response("", { status: 429, headers: { "retry-after": "30" } });
		const adapter = createReportPortalAdapter({ name: "rp", baseUrl: "https://rp.example.com", project: "p", token: "t", fetchImpl });
		await expect(adapter.listLaunches({})).rejects.toThrow(RateLimitError);
	});

	it("throws a typed ReportPortalApiError with status+body on a 500", async () => {
		const fetchImpl: FetchLike = async () => new Response("internal error", { status: 500 });
		const adapter = createReportPortalAdapter({ name: "rp", baseUrl: "https://rp.example.com", project: "p", token: "t", fetchImpl });
		await expect(adapter.listLaunches({})).rejects.toThrow(ReportPortalApiError);
	});
});

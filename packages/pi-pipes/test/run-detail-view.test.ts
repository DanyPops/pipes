import { describe, expect, it, mock } from "bun:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { type RunDetailData, runDetailText, showRunDetailView } from "../src/run-detail-view.ts";

const fakeTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function fakeTui(rows = 40) {
	return { terminal: { rows }, requestRender: mock(() => {}) } as unknown as TUI;
}

function data(overrides: Partial<RunDetailData> = {}): RunDetailData {
	return { check: { backend: "gh", jobRef: "ci.yml", runId: "42", status: "success" }, ...overrides };
}

async function renderView(
	runData: RunDetailData,
	rows = 40,
): Promise<{
	notifications: Array<{ message: string; level?: string }>;
	component?: { render(w: number): string[]; handleInput?(d: string): void };
}> {
	const notifications: Array<{ message: string; level?: string }> = [];
	let component: { render(w: number): string[]; handleInput?(d: string): void } | undefined;
	const ctx = {
		mode: "tui",
		ui: {
			notify(message: string, level?: string) {
				notifications.push({ message, level });
			},
			async custom(factory: (tui: TUI, theme: Theme, kb: unknown, done: () => void) => unknown) {
				component = (await factory(fakeTui(rows), fakeTheme, {}, () => {})) as {
					render(w: number): string[];
					handleInput?(d: string): void;
				};
			},
		},
	} as unknown as ExtensionCommandContext;
	await showRunDetailView(ctx, runData);
	return { notifications, component };
}

describe("showRunDetailView", () => {
	it("frames the view with a full-width border rule top and bottom", async () => {
		const { component } = await renderView(data());
		const lines = component!.render(80);
		expect(lines[0]).toBe("\u2500".repeat(80));
		expect(lines.at(-1)).toBe("\u2500".repeat(80));
	});

	it("titles the view with backend/jobRef #runId", async () => {
		const { component } = await renderView(data());
		const rendered = component!.render(80).join("\n");
		expect(rendered).toContain("gh/ci.yml #42");
	});

	it("renders status, checkedAt, and url fields when present", async () => {
		const { component } = await renderView(
			data({
				check: {
					backend: "gh",
					jobRef: "ci.yml",
					runId: "42",
					status: "failure",
					checkedAt: "2026-01-01T00:00:00Z",
					url: "https://example.test/run/42",
				},
			}),
		);
		const rendered = component!.render(100).join("\n");
		expect(rendered).toContain("Status: failure");
		expect(rendered).toContain("Checked: 2026-01-01T00:00:00Z");
		expect(rendered).toContain("URL: https://example.test/run/42");
	});

	it("omits the failure section entirely when there is no failure", async () => {
		const { component } = await renderView(data());
		expect(component!.render(100).join("\n")).not.toContain("Failure:");
	});

	it("renders the failure classification and failed job when present", async () => {
		const { component } = await renderView(data({ failure: { classification: "test-failure", failedJob: "build" } }));
		const rendered = component!.render(100).join("\n");
		expect(rendered).toContain("Failure:");
		expect(rendered).toContain("test-failure");
		expect(rendered).toContain("job: build");
	});

	it("omits the log section entirely when there is no log", async () => {
		const { component } = await renderView(data());
		expect(component!.render(100).join("\n")).not.toContain("Log (");
	});

	it("renders the log excerpt with its line count", async () => {
		const { component } = await renderView(data({ log: { lines: ["line one", "line two"], totalLines: 2 } }));
		const rendered = component!.render(100).join("\n");
		expect(rendered).toContain("Log (2 line(s)):");
		expect(rendered).toContain("line one");
		expect(rendered).toContain("line two");
	});

	it("marks a truncated log in its heading", async () => {
		const { component } = await renderView(data({ log: { lines: ["line one"], totalLines: 500, truncated: true } }));
		expect(component!.render(100).join("\n")).toContain("Log (500 line(s), truncated):");
	});

	it("always shows scroll keys in the footer, even when everything already fits on screen", async () => {
		const { component } = await renderView(data());
		const rendered = component!.render(100).join("\n");
		expect(rendered).toContain("\u2191/\u2193 scroll");
		expect(rendered).toContain("pgup/pgdn page");
		expect(rendered).not.toMatch(/\d+-\d+\/\d+/);
	});

	it("escape closes the view", async () => {
		let closed = false;
		const ctx = {
			mode: "tui",
			ui: {
				notify() {},
				async custom(factory: (tui: TUI, theme: Theme, kb: unknown, done: () => void) => unknown) {
					const component = (await factory(fakeTui(), fakeTheme, {}, () => {
						closed = true;
					})) as { render(w: number): string[]; handleInput?(d: string): void };
					component.render(80);
					component.handleInput?.("\x1b");
				},
			},
		} as unknown as ExtensionCommandContext;
		await showRunDetailView(ctx, data());
		expect(closed).toBe(true);
	});

	it("down/up scroll within bounds; scrolling is reflected in the footer position", async () => {
		const longLog = Array.from({ length: 60 }, (_, i) => `log line ${i}`);
		const { component } = await renderView(data({ log: { lines: longLog, totalLines: 60 } }), 15);
		const before = component!.render(100).join("\n");
		expect(before).toContain("1-");
		component!.handleInput?.("\x1b[B"); // down
		const after = component!.render(100).join("\n");
		expect(after).toContain("2-");
	});

	it("uses a plain-text notification outside interactive mode, including the log", async () => {
		const notifications: string[] = [];
		const ctx = { mode: "rpc", ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionCommandContext;
		await showRunDetailView(ctx, data({ log: { lines: ["line one"], totalLines: 1 } }));
		expect(notifications[0]).toContain("gh/ci.yml #42");
		expect(notifications[0]).toContain("line one");
	});
});

describe("runDetailText", () => {
	it("renders a compact plain-text summary", () => {
		const text = runDetailText(data({ failure: { classification: "test-failure" } }));
		expect(text).toContain("gh/ci.yml #42 -- success");
		expect(text).toContain("Failure: test-failure");
	});
});

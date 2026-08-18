/**
 * Adopts @danypops/vehicle-conformance's dual-channel matrix against pi-pipes' real production
 * rendering path (renderResultText/summarize/findFirstUrl/openLine/renderCiCall) -- proves this
 * consumer's own bespoke ci tool rendering is conformant (doc 4e9e08c1 Finding 5), not just the
 * inherited generic Shell path.
 *
 * Structural gap this fixture makes explicit rather than papering over: pi-pipes' `ci` tool
 * supplies a custom `renderers()` but no `presentations()` projector at all (see vehicle-client.ts's
 * registerVehicleTools options) -- vehicle-client-pi's own tool-creation.ts then persists
 * `details.output` as the raw, unbounded application output with NO presentation-details bound or
 * schema-driven redaction, unlike every other consumer surveyed for doc 4e9e08c1 (tickets/packed/
 * web-spider/vehicle-client-pi's own generic default). There is therefore no real "custom projector"
 * to exercise a rejecting invalidProjection() against; this fixture uses the same
 * assertJsonSafePresentation every projector-based consumer is validated through, as the closest
 * honest stand-in for "the documented projector exception policy" pi-pipes doesn't currently wire
 * up for itself. Fixing that (adding a real bounded projector to the ci tool) is a separate,
 * larger change than adopting this conformance suite -- tracked as a follow-up, not silently done
 * here.
 */
import { assertJsonSafePresentation } from "@danypops/vehicle-client-pi/vehicle-render-model";
import { runToolShellDualChannelConformance, type ToolShellDualChannelFixture } from "@danypops/vehicle-conformance";
import { initTheme, Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { findFirstUrl, openLine, renderResultText, summarize } from "../src/ci-render.ts";
import { renderCiCall } from "../src/vehicle-client.ts";

// A real Theme emitting real ANSI SGR escapes -- required because the conformance suite's own
// physical-line-width assertion strips real ANSI via a CSI regex before counting visible width.
const REAL_FG_COLORS: Record<ThemeColor, string> = {
	accent: "#ee0000",
	border: "#4d4d4d",
	borderAccent: "#ee0000",
	borderMuted: "#383838",
	success: "#6c9b4b",
	error: "#bd6e51",
	warning: "#dca614",
	muted: "#8f8f8f",
	dim: "#757575",
	text: "#e0e0e0",
	thinkingText: "#8f8f8f",
	searchMatchText: "#8f8f8f",
	userMessageText: "#e0e0e0",
	customMessageText: "#e0e0e0",
	customMessageLabel: "#876fd4",
	toolTitle: "#d39292",
	toolOutput: "#e0e0e0",
	mdHeading: "#e0e0e0",
	mdLink: "#0066cc",
	mdLinkUrl: "#0066cc",
	mdCode: "#e0e0e0",
	mdCodeBlock: "#e0e0e0",
	mdCodeBlockBorder: "#383838",
	mdQuote: "#8f8f8f",
	mdQuoteBorder: "#383838",
	mdHr: "#383838",
	mdListBullet: "#e0e0e0",
	toolDiffAdded: "#6c9b4b",
	toolDiffRemoved: "#bd6e51",
	toolDiffContext: "#8f8f8f",
	syntaxComment: "#8f8f8f",
	syntaxKeyword: "#876fd4",
	syntaxFunction: "#63bdbd",
	syntaxVariable: "#e0e0e0",
	syntaxString: "#6c9b4b",
	syntaxNumber: "#dca614",
	syntaxType: "#63bdbd",
	syntaxOperator: "#e0e0e0",
	syntaxPunctuation: "#e0e0e0",
	thinkingOff: "#8f8f8f",
	thinkingMinimal: "#8f8f8f",
	thinkingLow: "#8f8f8f",
	thinkingMedium: "#8f8f8f",
	thinkingHigh: "#8f8f8f",
	thinkingXhigh: "#8f8f8f",
	thinkingMax: "#8f8f8f",
	bashMode: "#e0e0e0",
};

const REAL_BG_COLORS = {
	selectedBg: "#292929",
	userMessageBg: "#1f1f1f",
	customMessageBg: "#1b0d33",
	toolPendingBg: "#1f1f1f",
	toolSuccessBg: "#1d2b12",
	toolErrorBg: "#4c1405",
};

const theme = new Theme(REAL_FG_COLORS, REAL_BG_COLORS, "truecolor");
initTheme();

/** Mirrors renderCiResult's own non-progress-bar composition (vehicle-client.ts): renderResultText,
 * then an appended clickable URL line if the raw output carries one anywhere. */
function renderTextLines(details: unknown, contentText: string, isPartial: boolean): string[] {
	const result = { content: [{ type: "text" as const, text: contentText }], details: details as { output?: unknown } | undefined };
	let text = renderResultText(result, isPartial, false, theme);
	const data = result.details?.output;
	if (data !== undefined) {
		const url = findFirstUrl(data);
		if (url) text += `\n${openLine(url, theme)}`;
	}
	return text.split("\n");
}

const fixture: ToolShellDualChannelFixture = {
	label: "pi-pipes",
	async create() {
		const subject = {
			bounds: { modelContentBytes: 4_096, presentationDetailsBytes: 24_576 },
			execute: async () => {
				const output = {
					verdict: { check: { backend: "github", jobRef: "ci.yml", runId: "1", status: "success" } },
					marker: "PRESENTATION_ONLY",
				};
				return { content: "MODEL_ONLY: semantic result", details: { output } };
			},
			render: (snapshot: { content: string; details: unknown }, options: { width: 40 | 80 | 120; expanded: boolean; partial?: boolean }) =>
				renderTextLines(snapshot.details, snapshot.content, options.partial ?? false).map((line) => line.slice(0, options.width)),
			// pi-pipes' own real details shape is exactly {output} (no separate "presentation" field --
			// see this file's own top comment) -- .output/.progress are the ONLY two slots renderResultText
			// reads, and *anything* assigned there is treated as valid data, not malformed. Wrapping a
			// malformed/unknown replay candidate under a synthetic "presentation" key that pi-pipes never
			// reads is what actually exercises "a value that ISN'T real output/progress falls back to
			// content", the same interpretive choice made for the vehicle-client-pi and pi-tickets fixtures.
			replay: (details: unknown, fallbackContent: string, options: { width: 40 | 80 | 120 }) =>
				renderTextLines({ presentation: details }, fallbackContent, false).map((line) => line.slice(0, options.width)),
			renderCall: (args: unknown, width: 40 | 80 | 120) => renderCiCall("ci.status", args, theme).render(width),
			invalidProjection: async () => {
				// pi-pipes' ci tool supplies no custom projector at all -- see this file's own top
				// comment. This exercises the same shared validation every projector-based consumer
				// goes through, as the closest honest stand-in.
				const cyclic: Record<string, unknown> = {};
				cyclic.self = cyclic;
				assertJsonSafePresentation(cyclic, 24_576);
			},
			// One representative real ci.*/rp.* output shape per branch summarize() dispatches on --
			// proves the real duck-typed chain differentiates its own declared shapes instead of
			// collapsing most of them into an undifferentiated raw-JSON dump (the pi-web-spider bug
			// class, generalized to a shape-check chain with no discriminated union at all).
			declaredValueCases: [
				{ value: "ci.help", rawPayload: { backends: [{ name: "github", capabilities: "trigger" }], pipelines: ["lector-ci"] } },
				{ value: "ci.presets.list", rawPayload: { presets: [{ name: "p1", backend: "github", steps: [{ jobName: "build" }] }] } },
				{ value: "ci.presets.set", rawPayload: { preset: { name: "p1", backend: "github", steps: [{ jobName: "build" }] } } },
				{ value: "ci.presets.remove", rawPayload: { removed: true } },
				{
					value: "ci.status.pipeline",
					rawPayload: { pipelineRun: { pipeline: "lector-ci", status: "success", steps: [{ jobName: "build", status: "success" }] } },
				},
				{
					value: "ci.status.direct",
					rawPayload: { verdict: { check: { backend: "github", jobRef: "ci.yml", runId: "1", status: "failure" } } },
				},
				{ value: "ci.trigger", rawPayload: { result: { backend: "github", jobRef: "ci.yml", buildNumber: "42" } } },
				{ value: "ci.wait", rawPayload: { status: "running", buildNumber: "42", progressPercent: 50, overdue: false } },
				{ value: "ci.cancel", rawPayload: { status: "cancelled", runId: "42" } },
				{ value: "ci.log", rawPayload: { totalLines: 120, truncated: true } },
				{ value: "ci.discover.repos", rawPayload: { repos: [{ name: "vehicle", private: false }] } },
				{ value: "ci.search", rawPayload: { runs: [{ id: "1" }, { id: "2" }] } },
				{ value: "ci.chain", rawPayload: { status: "success", name: "root", children: [{ status: "success", name: "child" }] } },
			],
			renderDeclaredValue: (_value: string, rawPayload: unknown, options: { width: 40 | 80 | 120 }) =>
				summarize(rawPayload, theme)
					.split("\n")
					.map((line) => line.slice(0, options.width)),
		};
		return { subject, cleanup: () => Promise.resolve() };
	},
};

runToolShellDualChannelConformance(fixture);

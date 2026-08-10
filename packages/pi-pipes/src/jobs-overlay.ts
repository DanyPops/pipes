/**
 * Persistent above-editor widget for currently ci_subscribe'd jobs -- mirrors pi-papyrus's own
 * TaskOverlay/NoteOverlay (extension/src/index.ts): factory-form ctx.ui.setWidget registration,
 * requestRender on refresh, hides the widget entirely (setWidget(key, undefined)) rather than an
 * empty box once nothing is subscribed, and a BoundedPoll fallback since pi-pipes has no push
 * channel yet for "ci" (packages/pipes' own PushChannel.publish("ci", ...) exists daemon-side but
 * nothing here subscribes to it -- see the filed task's own note on this).
 *
 * Deliberately poll-only (no push channel wired up for "ci" yet), but IS session-scoped: each
 * overlay instance is constructed with its own real Pi session id (see index.ts) and passes it as
 * ci.subscribed's subscriberId on every fetch, so this session's own widget/ticker only ever sees
 * (and gets notified about) the jobs *this* session itself subscribed to -- fixing a real, proven
 * leak where any session's finished job notified every other concurrently-running session too.
 */
import type { AgentNotifier, AgentPollTicker } from "@danypops/vehicle-client-pi/agent-poll-ticker";
import { reportAgentPollTick } from "@danypops/vehicle-client-pi/agent-poll-ticker";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { ProgressBarGlyphStyle, ProgressBarGlyphs } from "malevich-tui-components";
import { BoundedPoll } from "./bounded-poll.ts";
import { createJobTicker } from "./job-ticker.ts";
import { fetchSubscribedJobs } from "./jobs-client.ts";
import { buildJobsWidgetProjection, type JobsWidgetRow, renderJobsWidgetLines } from "./jobs-widget.ts";

export type { AgentNotifier } from "@danypops/vehicle-client-pi/agent-poll-ticker";

const WIDGET_KEY = "pi-pipes-jobs";

/** Matches packages/pipes' own RUN_POOL_SYNC_INTERVAL_MS's order of magnitude (30s) -- polling much
 * faster than the daemon's own background sync refreshes the pool would just re-read stale data. */
export const JOBS_WIDGET_POLL_INTERVAL_MS = 15_000;

export class JobsOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private registered = false;
	// biome-ignore lint/suspicious/noExplicitAny: same TUI-handle shape pi-papyrus's own overlays keep untyped (requestRender is all that's used).
	private tui: any | undefined;
	private rows: JobsWidgetRow[] = [];
	private readonly poll = new BoundedPoll();
	private readonly ticker: AgentPollTicker<JobsWidgetRow>;

	constructor(
		private readonly progressBarGlyphs: ProgressBarGlyphs | ProgressBarGlyphStyle = "blocks",
		private readonly notifier?: AgentNotifier,
		ticker: AgentPollTicker<JobsWidgetRow> = createJobTicker(),
		/** This session's own real Pi session id, threaded into every ci.subscribed fetch as
		 * subscriberId. Undefined falls back to the daemon's global, unscoped view (e.g. a caller with
		 * no real session identity to scope by). */
		private readonly subscriberId?: string,
	) {
		this.ticker = ticker;
	}

	setUI(ctx: ExtensionUIContext): void {
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.registered = false;
			this.tui = undefined;
		}
	}

	/**
	 * Never throws: called from a poll timer and from session_start, neither of which should turn a
	 * best-effort status widget into a crashed extension host over a daemon that isn't running yet
	 * or a rendering bug.
	 */
	async refresh(): Promise<void> {
		let fetched = true;
		try {
			this.rows = await fetchSubscribedJobs(this.subscriberId);
		} catch {
			this.rows = [];
			fetched = false;
		}
		// A failed fetch must never reach the ticker: an empty result from a transient daemon hiccup
		// would otherwise read as every subscribed job having just finished. Skip the tick entirely
		// (not feed it []) so the ticker's own baseline survives the hiccup unchanged.
		if (fetched) this.notifyAgentIfNeeded();
		try {
			this.render();
		} catch {
			// A rendering bug must not crash the extension host over a best-effort status widget.
		}
	}

	private notifyAgentIfNeeded(): void {
		reportAgentPollTick(this.ticker, this.rows, this.notifier);
	}

	private render(): void {
		if (!this.uiCtx) return;
		const projection = buildJobsWidgetProjection(this.rows);

		if (projection.total === 0) {
			if (this.registered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.registered = false;
				this.tui = undefined;
			}
			return;
		}

		if (!this.registered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				// biome-ignore lint/suspicious/noExplicitAny: tui is only ever used for requestRender(), matching pi-papyrus's own overlays.
				(tui: any, theme: Theme) => {
					this.tui = tui;
					return {
						render: (width: number) => renderJobsWidgetLines(theme, buildJobsWidgetProjection(this.rows), width, this.progressBarGlyphs),
						invalidate: () => {
							// Theme changed -- force re-registration, matching pi-papyrus's own overlays.
							this.registered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.registered = true;
		} else {
			this.tui?.requestRender?.();
		}
	}

	/** Fallback for a subscription change no event announces yet -- there is no push channel wired
	 * up for "ci" on the client side today (see this file's own doc comment). */
	startPolling(intervalMs: number = JOBS_WIDGET_POLL_INTERVAL_MS): void {
		this.poll.start(intervalMs, () => {
			void this.refresh();
		});
	}

	stopPolling(): void {
		this.poll.stop();
	}

	dispose(): void {
		this.stopPolling();
		this.uiCtx?.setWidget(WIDGET_KEY, undefined);
		this.registered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
	}
}

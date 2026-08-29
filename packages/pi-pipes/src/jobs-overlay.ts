/**
 * Renders this session's subscribed CI jobs and delivers exact terminal results. Authenticated
 * push transitions provide immediate completion delivery; bounded polling refreshes the widget and
 * resolves terminal status when a push event is missed. Every path is scoped by Pi session id.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { AutoRotatingWindow, type ProgressBarGlyphStyle, type ProgressBarGlyphs } from "malevich-tui-components";
import { BoundedPoll } from "./bounded-poll.ts";
import { createJobTicker, type JobCompletion, type JobTicker } from "./job-ticker.ts";
import { createJobsClientSession, type JobsClientSession } from "./jobs-client.ts";
import { buildJobsWidgetProjection, type JobsWidgetRow, PIPES_JOBS_WIDGET_VISIBLE_ROWS, renderJobsWidgetLines } from "./jobs-widget.ts";

/** Delivers background CI state into the active Pi session. */
export interface AgentNotifier {
	sendUserMessage(content: string, options: { deliverAs: "followUp"; triggerTurn: boolean }): void;
}

const WIDGET_KEY = "pi-pipes-jobs";

/** Matches packages/pipes' own RUN_POOL_SYNC_INTERVAL_MS's order of magnitude (30s) -- polling much
 * faster than the daemon's own background sync refreshes the pool would just re-read stale data. */
export const JOBS_WIDGET_POLL_INTERVAL_MS = 15_000;

/** How often the widget's own auto-rotating overflow page advances. */
export const JOBS_WIDGET_ROTATION_INTERVAL_MS = 6_000;

export class JobsOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private registered = false;
	// biome-ignore lint/suspicious/noExplicitAny: same TUI-handle shape pi-papyrus's own overlays keep untyped (requestRender is all that's used).
	private tui: any | undefined;
	private rows: JobsWidgetRow[] = [];
	/** De-dupes degradation reports so a persistently-failing fetch/render notifies once, not once
	 * per poll tick (JOBS_WIDGET_POLL_INTERVAL_MS) -- see reportDegradation()'s own doc comment for
	 * why this exists at all: refresh()'s catches below used to swallow every exception with zero
	 * trace, which is exactly how a real regression (0.18.7's startedAt Date/string mismatch) went
	 * unnoticed as "no jobs visible" with no error anywhere to investigate. */
	private lastFetchErrorMessage: string | undefined;
	private lastRenderErrorMessage: string | undefined;
	private readonly poll = new BoundedPoll();
	/** Repaint-only ticker (no data refetch) so the widget's own auto-rotating page visibly advances
	 * even when nothing else has changed. */
	private readonly rotationPoll = new BoundedPoll();
	private readonly rotation = new AutoRotatingWindow({
		totalRows: 0,
		pageSize: PIPES_JOBS_WIDGET_VISIBLE_ROWS,
		intervalMs: JOBS_WIDGET_ROTATION_INTERVAL_MS,
	});
	private readonly ticker: JobTicker;

	constructor(
		private readonly progressBarGlyphs: ProgressBarGlyphs | ProgressBarGlyphStyle = "blocks",
		private readonly notifier?: AgentNotifier,
		ticker: JobTicker = createJobTicker(),
		/** This session's own real Pi session id, threaded into every ci.subscribed fetch as
		 * subscriberId. Undefined falls back to the daemon's global, unscoped view (e.g. a caller with
		 * no real session identity to scope by). */
		private readonly subscriberId?: string,
		/**
		 * A real ExtensionContext.isIdle() reading, captured once at session_start (see index.ts) and
		 * reused across every later poll tick -- startPolling()'s own BoundedPoll fires refresh() on a
		 * fixed interval with no ExtensionContext of its own to ask. Without this, a poll landing while
		 * a tool call was still executing queued a "this job just finished" notification for a job that
		 * died entirely within one long blocking turn, based on data collected before the turn's own
		 * real state was settled -- see @danypops/vehicle-client-pi's reportAgentPollTick own doc
		 * comment for the full mechanism. Undefined (e.g. an older/test caller not yet passing it)
		 * preserves the old always-tick behavior unchanged.
		 */
		private readonly isIdle?: () => boolean,
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
		let client: JobsClientSession | undefined;
		try {
			client = createJobsClientSession();
			this.rows = await client.fetchSubscribedJobs(this.subscriberId);
			this.lastFetchErrorMessage = undefined;
		} catch (err) {
			this.rows = [];
			fetched = false;
			this.reportDegradation("fetch", err);
		}
		// A failed fetch must never reach the ticker: an empty result from a transient daemon hiccup
		// would otherwise read as every subscribed job having just finished. Skip the tick entirely
		// (not feed it []) so the ticker's own baseline survives the hiccup unchanged.
		if (fetched && client) await this.notifyAgentIfNeeded(client);
		try {
			this.render();
			this.lastRenderErrorMessage = undefined;
		} catch (err) {
			// A rendering bug must not crash the extension host over a best-effort status widget --
			// but it must still leave a trace (see reportDegradation()) instead of vanishing silently.
			this.reportDegradation("render", err);
		}
	}

	private async notifyAgentIfNeeded(client: JobsClientSession): Promise<void> {
		if (!this.notifier || (this.isIdle && !this.isIdle())) return;
		const notice = await this.ticker.tick(this.rows, (row) => client.fetchJobCompletion(row));
		if (!notice) return;
		try {
			this.notifier.sendUserMessage(notice.content, { deliverAs: "followUp", triggerTurn: notice.triggerTurn });
		} catch {
			// A background notification must not crash the extension host.
		}
	}

	/** Delivers a session-authorized terminal transition from the daemon push channel. */
	notifyCompletion(completion: JobCompletion): void {
		if (!this.notifier) return;
		const notice = this.ticker.completion(completion);
		if (!notice) return;
		try {
			this.notifier.sendUserMessage(notice.content, { deliverAs: "followUp", triggerTurn: true });
		} catch {
			// A background notification must not crash the extension host.
		}
	}

	/**
	 * Surfaces a fetch/render failure exactly once per distinct message, via ctx.ui.notify (the only
	 * sanctioned way an extension may report something -- never console.log/stdout, which corrupts
	 * the real TUI stream). Re-arms as soon as the message changes or the operation succeeds again
	 * (refresh() clears the corresponding lastXErrorMessage on success), so a fixed-then-different
	 * failure is reported again rather than staying suppressed forever by the first one seen.
	 *
	 * Without this, refresh()'s own try/catch (needed so a daemon hiccup or a rendering bug never
	 * crashes the extension host over a best-effort status widget) swallowed every exception with
	 * zero trace -- exactly how the 0.18.7 regression (Runtime column's row.startedAt.getTime()
	 * throwing on the real wire's plain ISO string, not a Date) presented as silent, unexplained
	 * "no jobs visible" with nothing to investigate.
	 */
	private reportDegradation(kind: "fetch" | "render", err: unknown): void {
		const message = err instanceof Error ? err.message : String(err);
		const last = kind === "fetch" ? this.lastFetchErrorMessage : this.lastRenderErrorMessage;
		if (last === message) return;
		if (kind === "fetch") this.lastFetchErrorMessage = message;
		else this.lastRenderErrorMessage = message;
		try {
			// `?.` on uiCtx alone is not enough -- a truthy-but-incomplete uiCtx (e.g. an older/test
			// fixture stubbing only setWidget) has notify itself as undefined, and calling that would
			// throw straight out of refresh()'s own catch block, defeating the exact "never throws"
			// contract this method exists to preserve. The outer try/catch is further defense: reporting
			// a failure must never itself become a new, unhandled way for refresh() to reject.
			this.uiCtx?.notify?.(`Pipes Jobs widget ${kind} failed: ${message}`, "warning");
		} catch {
			// Nowhere left to report a failure of the failure-reporter itself.
		}
	}

	private render(): void {
		if (!this.uiCtx) return;
		const projection = buildJobsWidgetProjection(this.rows);

		if (projection.total === 0) {
			if (this.registered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.registered = false;
				this.tui = undefined;
				this.rotationPoll.stop();
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
						render: (width: number) =>
							renderJobsWidgetLines(theme, buildJobsWidgetProjection(this.rows), width, this.progressBarGlyphs, this.rotation),
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
			this.rotationPoll.start(JOBS_WIDGET_ROTATION_INTERVAL_MS, () => this.tui?.requestRender?.());
		} else {
			this.tui?.requestRender?.();
		}
	}

	/** Polling fallback for widget refresh and terminal events missed while push was disconnected. */
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
		this.rotationPoll.stop();
		this.uiCtx?.setWidget(WIDGET_KEY, undefined);
		this.registered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
	}
}

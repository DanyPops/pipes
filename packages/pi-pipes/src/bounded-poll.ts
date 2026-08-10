/**
 * Idempotent start/stop wrapper over setInterval -- mirrors pi-papyrus's own bounded-poll.ts
 * (same "fallback refresh for a mutation no event announces" reasoning, applied here to the
 * subscribed-jobs widget instead of the task/note widgets). A second start() is a no-op rather
 * than a competing timer; stop() is safe to call even if never started.
 */
export class BoundedPoll {
	private timer: ReturnType<typeof setInterval> | undefined;

	start(intervalMs: number, tick: () => void): void {
		if (this.timer) return;
		this.timer = setInterval(tick, intervalMs);
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}
}

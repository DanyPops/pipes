/**
 * Every REST adapter's `doFetch` defaults to the platform `fetch` with no
 * deadline of its own -- a stalled TCP connection or a proxy that swallows
 * the response hangs that one call forever. `ci.wait`'s poll loop awaits
 * these calls directly, so one hung request freezes the whole wait with no
 * error and no further progress: indistinguishable from a real hang.
 * Wrapping the default fetch with a hard deadline turns that into a clear,
 * typed timeout error instead.
 */
import type { FetchLike } from "../auth/github-auth.ts";

export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

export class HttpTimeoutError extends Error {
	constructor(
		public readonly url: string,
		public readonly timeoutMs: number,
	) {
		super(`request timed out after ${timeoutMs}ms: ${url}`);
	}
}

/**
 * Races the real call against its own deadline rather than trusting the
 * wrapped `fetchImpl` to honor the AbortSignal it's given -- a well-behaved
 * implementation (the platform `fetch`) does, but a misbehaving or
 * test-double one might ignore it entirely, and this wrapper's whole job is
 * to guarantee its own promise always settles by `timeoutMs` regardless.
 * The abort signal is still passed through so a real fetch can actually
 * cancel the underlying request instead of leaking it after we give up.
 */
export function withTimeout(fetchImpl: FetchLike = fetch as unknown as FetchLike, timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS): FetchLike {
	return (url, init) => {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		const deadline = new Promise<Response>((_resolve, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new HttpTimeoutError(url, timeoutMs));
			}, timeoutMs);
		});
		return Promise.race([fetchImpl(url, { ...init, signal: controller.signal }), deadline]).finally(() => clearTimeout(timer));
	};
}

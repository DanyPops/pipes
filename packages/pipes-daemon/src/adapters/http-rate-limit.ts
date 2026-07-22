/**
 * Rate-limit header parsing shared across REST adapters. Checks both the
 * legacy X-RateLimit-* convention (GitHub) and the newer IETF-draft
 * RateLimit-* convention with no X- prefix (GitLab, newer GitHub
 * endpoints) — a single-convention parser would silently under-read
 * whichever backend uses the other one.
 */
export interface RateLimitInfo {
	limit?: number;
	remaining?: number;
	reset?: Date;
}

export class RateLimitError extends Error {
	constructor(
		public readonly backend: string,
		public readonly retryAfterMs: number,
		public readonly info: RateLimitInfo,
	) {
		super(`rate limit exceeded for ${backend}, retry after ${Math.round(retryAfterMs / 1000)}s`);
	}
}

const DEFAULT_RETRY_AFTER_MS = 60_000;

export function parseRateLimitHeaders(headers: Headers): RateLimitInfo {
	const limitHeader = headers.get("x-ratelimit-limit") ?? headers.get("ratelimit-limit");
	const remainingHeader = headers.get("x-ratelimit-remaining") ?? headers.get("ratelimit-remaining");
	const resetHeader = headers.get("x-ratelimit-reset") ?? headers.get("ratelimit-reset");

	const info: RateLimitInfo = {};
	if (limitHeader) info.limit = Number.parseInt(limitHeader, 10);
	if (remainingHeader) info.remaining = Number.parseInt(remainingHeader, 10);
	if (resetHeader) {
		// X-RateLimit-Reset is a Unix epoch seconds timestamp (GitHub); the
		// IETF-draft RateLimit-Reset is delta-seconds from now (GitLab) — both
		// are small integers, so distinguish by magnitude rather than by which
		// header name matched (GitHub can also emit the unprefixed name).
		const value = Number.parseInt(resetHeader, 10);
		if (Number.isFinite(value)) {
			info.reset = value > 1_000_000_000 ? new Date(value * 1000) : new Date(Date.now() + value * 1000);
		}
	}
	return info;
}

/** Retry-After is either delta-seconds or an HTTP-date; defaults to 60s if neither parses. */
export function parseRetryAfterMs(header: string | null): number {
	if (!header) return DEFAULT_RETRY_AFTER_MS;
	const seconds = Number.parseInt(header, 10);
	if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
	const date = new Date(header);
	const deltaMs = date.getTime() - Date.now();
	return Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : DEFAULT_RETRY_AFTER_MS;
}

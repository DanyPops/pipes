/**
 * Shared OAuth token resolution for adapters, called fresh before every
 * request rather than baked into the adapter at construction — a token
 * captured once at boot would go stale the moment it expires, with
 * nothing to notice. `createTokenProvider` re-reads the store each call,
 * so a token rotated by `refresh` (or replaced entirely by a fresh login)
 * is picked up on the adapter's very next request.
 *
 * A single in-flight refresh is shared across concurrent callers rather
 * than each starting its own — not just an efficiency nicety. Several
 * providers issue rotating, single-use refresh tokens, so two independent
 * refresh calls racing on the same stale refresh token would have the
 * loser fail outright. JS's run-to-completion semantics make this safe
 * with a plain closure variable: everything from reading the store to
 * assigning the in-flight promise happens synchronously, so a second
 * caller can only ever observe the flag after the first caller has set it.
 */

export interface RefreshableAccessToken {
	accessToken: string;
	refreshToken?: string;
	expiresInS?: number;
	obtainedAt: number;
}

export interface TokenProviderStore<T extends RefreshableAccessToken> {
	load(): T | undefined;
	save(token: T): void;
}

export interface TokenProviderOptions<T extends RefreshableAccessToken> {
	store: TokenProviderStore<T>;
	/** Omit for backends whose tokens never expire (e.g. GitHub OAuth App device-flow tokens). */
	refresh?: (current: T) => Promise<T>;
	/** Consulted whenever there is no usable stored or refreshed credential. */
	staticFallback: () => string | undefined;
	/** Refresh this far ahead of actual expiry so a request never races a token's last moment of validity. */
	refreshSkewMs?: number;
	/**
	 * Optional, additive: a running Enigma vault (github.com/DanyPops/enigma), checked first on
	 * every call if configured. Never a hard dependency -- resolves undefined immediately, never
	 * throws, if Enigma isn't running or doesn't have this backend. Because getToken() already
	 * runs fresh before every request (see the module doc above), this gets live, per-request
	 * freshness for free -- a credential Enigma rotates is picked up on the very next call, no
	 * daemon restart needed, unlike a snapshot resolved once at startup.
	 */
	enigmaSource?: () => Promise<string | undefined>;
}

const DEFAULT_REFRESH_SKEW_MS = 60_000;

export function isRefreshableTokenExpired(token: RefreshableAccessToken, skewMs = DEFAULT_REFRESH_SKEW_MS): boolean {
	if (token.expiresInS === undefined) return false;
	return Date.now() >= token.obtainedAt + token.expiresInS * 1000 - skewMs;
}

/** Builds a `getToken()` an adapter calls before every request instead of holding a static token string. */
export function createTokenProvider<T extends RefreshableAccessToken>(
	options: TokenProviderOptions<T>,
): () => Promise<string | undefined> {
	let inFlight: Promise<T | undefined> | undefined;

	return async function getToken(): Promise<string | undefined> {
		if (options.enigmaSource) {
			// Deliberately defensive here even though the real tryEnigmaCredential never throws
			// (every one of its own failure paths already resolves undefined): enigmaSource is a
			// caller-supplied function, and this integration's whole premise is that it must never
			// be capable of breaking a request, matching how `refresh`'s own failures are contained
			// just below rather than propagated.
			const fromEnigma = await options.enigmaSource().catch(() => undefined);
			if (fromEnigma) return fromEnigma;
		}

		const stored = options.store.load();
		if (!stored) return options.staticFallback();
		if (!isRefreshableTokenExpired(stored, options.refreshSkewMs)) return stored.accessToken;
		if (!options.refresh || !stored.refreshToken) return options.staticFallback();

		if (!inFlight) {
			inFlight = (async () => {
				try {
					// Re-check under the "lock": another caller may have already refreshed
					// while this one was queued behind the synchronous prefix above.
					const current = options.store.load() ?? stored;
					if (!isRefreshableTokenExpired(current, options.refreshSkewMs)) return current;
					if (!current.refreshToken) return undefined;
					const refreshed = await options.refresh?.(current);
					if (!refreshed) return undefined;
					options.store.save(refreshed);
					return refreshed;
				} catch {
					return undefined;
				} finally {
					inFlight = undefined;
				}
			})();
		}

		const refreshedOrNot = await inFlight;
		return refreshedOrNot?.accessToken ?? options.staticFallback();
	};
}

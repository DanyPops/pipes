/**
 * Adds Enigma as an optional, additive credential source on top of
 * vehicle-server's shared vault.ts token provider -- vehicle-server stays
 * vendor-agnostic (it has no idea Enigma exists), so this thin wrapper is
 * the one place pipes checks a running Enigma vault first, on every call,
 * before falling through to vehicle-server's own store/refresh/static chain.
 */
import { createTokenProvider as createBaseTokenProvider, type RefreshableAccessToken, type TokenProviderOptions as BaseTokenProviderOptions } from "@danypops/vehicle-server/vault";

export type { RefreshableAccessToken, TokenProviderStore } from "@danypops/vehicle-server/vault";

export interface TokenProviderOptions<T extends RefreshableAccessToken> extends BaseTokenProviderOptions<T> {
	/**
	 * Optional, additive: a running Enigma vault (github.com/DanyPops/enigma), checked first on
	 * every call if configured. Never a hard dependency -- resolves undefined immediately, never
	 * throws, if Enigma isn't running or doesn't have this backend. Because getToken() already
	 * runs fresh before every request, this gets live, per-request freshness for free -- a
	 * credential Enigma rotates is picked up on the very next call, no daemon restart needed,
	 * unlike a snapshot resolved once at startup.
	 */
	enigmaSource?: () => Promise<string | undefined>;
}

/** Builds a `getToken()` an adapter calls before every request instead of holding a static token string. */
export function createTokenProvider<T extends RefreshableAccessToken>(options: TokenProviderOptions<T>): () => Promise<string | undefined> {
	const base = createBaseTokenProvider(options);

	return async function getToken(): Promise<string | undefined> {
		if (options.enigmaSource) {
			// Deliberately defensive here even though the real tryEnigmaCredential never throws
			// (every one of its own failure paths already resolves undefined): enigmaSource is a
			// caller-supplied function, and this integration's whole premise is that it must never
			// be capable of breaking a request, matching how vehicle-server's own `refresh` failures
			// are contained rather than propagated.
			const fromEnigma = await options.enigmaSource().catch(() => undefined);
			if (fromEnigma) return fromEnigma;
		}
		return base();
	};
}

import { describe, expect, it } from "bun:test";
import { createTokenProvider, type RefreshableAccessToken } from "../../src/adapters/token-provider.ts";

function fakeStore(initial: RefreshableAccessToken | undefined) {
	let current = initial;
	return {
		load: () => current,
		save: (token: RefreshableAccessToken) => {
			current = token;
		},
		get current() {
			return current;
		},
	};
}

const future = (ms: number) => new Date(Date.now() + ms).toISOString();
const past = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("createTokenProvider: delegates store/refresh/static-fallback to vehicle-server's own vault.ts", () => {
	it("returns the stored access token directly when it is fresh", async () => {
		const store = fakeStore({ accessToken: "fresh", expiresAt: future(3_600_000) });
		const getToken = createTokenProvider({ store, staticFallback: () => undefined });
		expect(await getToken()).toBe("fresh");
	});

	it("falls back to the static token when nothing is stored", async () => {
		const store = fakeStore(undefined);
		const getToken = createTokenProvider({ store, staticFallback: () => "static-pat" });
		expect(await getToken()).toBe("static-pat");
	});

	it("falls back to the static token when the stored token is expired and no refresh function is configured", async () => {
		const store = fakeStore({ accessToken: "stale", expiresAt: past(100_000), refreshToken: "r" });
		const getToken = createTokenProvider({ store, staticFallback: () => "static-pat" });
		expect(await getToken()).toBe("static-pat");
	});

	it("refreshes an expired token and persists the rotated credential back to the store", async () => {
		const store = fakeStore({ accessToken: "stale", expiresAt: past(100_000), refreshToken: "r1" });
		const getToken = createTokenProvider({
			store,
			refresh: async (current) => ({ accessToken: "rotated", expiresAt: future(3_600_000), refreshToken: `${current.refreshToken}-next` }),
			staticFallback: () => undefined,
		});
		expect(await getToken()).toBe("rotated");
		expect(store.current?.accessToken).toBe("rotated");
		expect(store.current?.refreshToken).toBe("r1-next");
	});

	it("falls back to the static token when refresh itself fails, rather than throwing", async () => {
		const store = fakeStore({ accessToken: "stale", expiresAt: past(100_000), refreshToken: "r1" });
		const getToken = createTokenProvider({
			store,
			refresh: async () => {
				throw new Error("refresh endpoint unreachable");
			},
			staticFallback: () => "static-pat",
		});
		expect(await getToken()).toBe("static-pat");
	});

	describe("enigmaSource: an optional, additive credential source checked first on every call -- pipes' own addition on top of vehicle-server's provider", () => {
		it("prefers Enigma's token over a fresh stored token, never even touching the store", async () => {
			const store = fakeStore({ accessToken: "fresh-stored", expiresAt: future(3_600_000) });
			const calls: string[] = [];
			const getToken = createTokenProvider({
				store,
				staticFallback: () => undefined,
				enigmaSource: async () => {
					calls.push("enigma");
					return "enigma-supplied-token";
				},
			});
			expect(await getToken()).toBe("enigma-supplied-token");
			expect(calls).toEqual(["enigma"]);
		});

		it("falls through to the existing store-then-static-PAT behavior unchanged when Enigma has nothing for this backend", async () => {
			const store = fakeStore({ accessToken: "fresh-stored", expiresAt: future(3_600_000) });
			const getToken = createTokenProvider({ store, staticFallback: () => undefined, enigmaSource: async () => undefined });
			expect(await getToken()).toBe("fresh-stored");
		});

		it("is checked fresh on every call -- Enigma rotating a credential is picked up on the very next getToken(), no restart needed", async () => {
			let enigmaToken = "enigma-token-v1";
			const store = fakeStore(undefined);
			const getToken = createTokenProvider({ store, staticFallback: () => undefined, enigmaSource: async () => enigmaToken });
			expect(await getToken()).toBe("enigma-token-v1");
			enigmaToken = "enigma-token-v2-rotated";
			expect(await getToken()).toBe("enigma-token-v2-rotated");
		});

		it("never fails a request just because Enigma's own lookup rejects -- defensively contained even though the real tryEnigmaCredential never throws", async () => {
			const store = fakeStore({ accessToken: "fresh-stored", expiresAt: future(3_600_000) });
			const getToken = createTokenProvider({
				store,
				staticFallback: () => "static-pat",
				enigmaSource: async () => {
					throw new Error("unexpected -- should never happen in production, but must not crash the request");
				},
			});
			expect(await getToken()).toBe("fresh-stored"); // falls through to the store, exactly as if enigmaSource were absent
		});
	});
});

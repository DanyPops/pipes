import { describe, expect, it } from "bun:test";
import { createTokenProvider, isRefreshableTokenExpired, type RefreshableAccessToken } from "../../src/adapters/token-provider.ts";

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

describe("isRefreshableTokenExpired", () => {
	it("treats a token with no expiresInS as never expired", () => {
		expect(isRefreshableTokenExpired({ accessToken: "a", obtainedAt: Date.now() })).toBe(false);
	});

	it("applies the refresh skew ahead of the literal expiry moment", () => {
		const token = { accessToken: "a", obtainedAt: Date.now() - 55_000, expiresInS: 60 };
		expect(isRefreshableTokenExpired(token, 10_000)).toBe(true); // 5s of real validity left, under the 10s skew
		expect(isRefreshableTokenExpired(token, 1_000)).toBe(false); // 5s left, above a 1s skew
	});
});

describe("createTokenProvider", () => {
	it("returns the stored access token directly when it is fresh", async () => {
		const store = fakeStore({ accessToken: "fresh", obtainedAt: Date.now(), expiresInS: 3600 });
		const getToken = createTokenProvider({ store, staticFallback: () => undefined });
		expect(await getToken()).toBe("fresh");
	});

	it("falls back to the static token when nothing is stored", async () => {
		const store = fakeStore(undefined);
		const getToken = createTokenProvider({ store, staticFallback: () => "static-pat" });
		expect(await getToken()).toBe("static-pat");
	});

	it("falls back to the static token when the stored token is expired and no refresh function is configured", async () => {
		const store = fakeStore({ accessToken: "stale", obtainedAt: Date.now() - 100_000, expiresInS: 60, refreshToken: "r" });
		const getToken = createTokenProvider({ store, staticFallback: () => "static-pat" });
		expect(await getToken()).toBe("static-pat");
	});

	it("refreshes an expired token and persists the rotated credential back to the store", async () => {
		const store = fakeStore({ accessToken: "stale", obtainedAt: Date.now() - 100_000, expiresInS: 60, refreshToken: "r1" });
		const getToken = createTokenProvider({
			store,
			refresh: async (current) => ({ accessToken: "rotated", obtainedAt: Date.now(), expiresInS: 3600, refreshToken: `${current.refreshToken}-next` }),
			staticFallback: () => undefined,
		});
		expect(await getToken()).toBe("rotated");
		expect(store.current?.accessToken).toBe("rotated");
		expect(store.current?.refreshToken).toBe("r1-next");
	});

	it("shares one in-flight refresh across concurrent callers instead of racing two refresh calls", async () => {
		const store = fakeStore({ accessToken: "stale", obtainedAt: Date.now() - 100_000, expiresInS: 60, refreshToken: "r1" });
		let refreshCalls = 0;
		const getToken = createTokenProvider({
			store,
			refresh: async () => {
				refreshCalls += 1;
				await new Promise((resolve) => setTimeout(resolve, 20));
				return { accessToken: "rotated", obtainedAt: Date.now(), expiresInS: 3600, refreshToken: "r2" };
			},
			staticFallback: () => undefined,
		});

		const [a, b, c] = await Promise.all([getToken(), getToken(), getToken()]);
		expect([a, b, c]).toEqual(["rotated", "rotated", "rotated"]);
		expect(refreshCalls).toBe(1);
	});

	it("falls back to the static token when refresh itself fails, rather than throwing", async () => {
		const store = fakeStore({ accessToken: "stale", obtainedAt: Date.now() - 100_000, expiresInS: 60, refreshToken: "r1" });
		const getToken = createTokenProvider({
			store,
			refresh: async () => {
				throw new Error("refresh endpoint unreachable");
			},
			staticFallback: () => "static-pat",
		});
		expect(await getToken()).toBe("static-pat");
	});

	it("allows a later call to refresh again after a prior refresh completed and the new token also expired", async () => {
		const store = fakeStore({ accessToken: "stale", obtainedAt: Date.now() - 100_000, expiresInS: 60, refreshToken: "r1" });
		let refreshCalls = 0;
		const getToken = createTokenProvider({
			store,
			refresh: async () => {
				refreshCalls += 1;
				return { accessToken: `rotated-${refreshCalls}`, obtainedAt: Date.now() - 100_000, expiresInS: 60, refreshToken: `r${refreshCalls + 1}` };
			},
			staticFallback: () => undefined,
		});

		await getToken();
		await getToken();
		expect(refreshCalls).toBe(2);
	});
});

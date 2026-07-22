import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFileTokenStore,
	DeviceFlowDeniedError,
	DeviceFlowExpiredError,
	type FetchLike,
	isTokenExpired,
	pollDeviceAccessToken,
	requestDeviceCode,
	resolveGitHubToken,
	resolveStaticToken,
	runDeviceFlow,
} from "../../../src/adapters/github/auth.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("requestDeviceCode", () => {
	it("parses the device code response", async () => {
		const fetchImpl = (async () =>
			jsonResponse({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 })) as FetchLike;

		const result = await requestDeviceCode({ clientId: "client-1", fetchImpl });
		expect(result).toEqual({ deviceCode: "dc", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresInS: 900, intervalS: 5 });
	});

	it("throws on a non-ok response", async () => {
		const fetchImpl = (async () => new Response("", { status: 500 })) as FetchLike;
		await expect(requestDeviceCode({ clientId: "client-1", fetchImpl })).rejects.toThrow(/HTTP 500/);
	});
});

describe("pollDeviceAccessToken", () => {
	it("returns a token on success", async () => {
		const fetchImpl = (async () => jsonResponse({ access_token: "gho_abc", token_type: "bearer", scope: "repo" })) as FetchLike;
		const token = await pollDeviceAccessToken({ clientId: "client-1", fetchImpl }, "dc");
		expect(token.accessToken).toBe("gho_abc");
		expect(token.expiresInS).toBeUndefined();
	});

	it("throws DeviceFlowDeniedError for access_denied", async () => {
		const fetchImpl = (async () => jsonResponse({ error: "access_denied" })) as FetchLike;
		await expect(pollDeviceAccessToken({ clientId: "client-1", fetchImpl }, "dc")).rejects.toThrow(DeviceFlowDeniedError);
	});
});

describe("runDeviceFlow", () => {
	it("polls through authorization_pending and slow_down before succeeding", async () => {
		let call = 0;
		const fetchImpl = (async (input: string) => {
			const url = String(input);
			if (url.includes("device/code")) {
				return jsonResponse({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 });
			}
			call++;
			if (call === 1) return jsonResponse({ error: "authorization_pending" });
			if (call === 2) return jsonResponse({ error: "slow_down", interval: 2 });
			return jsonResponse({ access_token: "gho_final", token_type: "bearer", scope: "repo" });
		}) as FetchLike;

		const sleeps: number[] = [];
		const token = await runDeviceFlow({
			clientId: "client-1",
			fetchImpl,
			sleepImpl: async (ms) => {
				sleeps.push(ms);
			},
			onPrompt: () => {},
		});

		expect(token.accessToken).toBe("gho_final");
		expect(call).toBe(3);
		expect(sleeps).toEqual([1000, 1000, 2000]); // initial interval, then widened after slow_down
	});

	it("throws DeviceFlowExpiredError once the device code's own expiry passes", async () => {
		const fetchImpl = (async (input: string) => {
			const url = String(input);
			if (url.includes("device/code")) {
				return jsonResponse({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 0, interval: 1 });
			}
			return jsonResponse({ error: "authorization_pending" });
		}) as FetchLike;

		await expect(
			runDeviceFlow({ clientId: "client-1", fetchImpl, sleepImpl: async () => {}, onPrompt: () => {} }),
		).rejects.toThrow(DeviceFlowExpiredError);
	});
});

describe("isTokenExpired", () => {
	it("treats a token with no expiresInS as non-expiring", () => {
		expect(isTokenExpired({ accessToken: "t", tokenType: "bearer", scope: "", obtainedAt: 0 })).toBe(false);
	});

	it("expires once obtainedAt + expiresInS has passed", () => {
		const token = { accessToken: "t", tokenType: "bearer", scope: "", obtainedAt: Date.now() - 10_000, expiresInS: 5 };
		expect(isTokenExpired(token)).toBe(true);
	});

	it("is not expired while still within its window", () => {
		const token = { accessToken: "t", tokenType: "bearer", scope: "", obtainedAt: Date.now(), expiresInS: 3600 };
		expect(isTokenExpired(token)).toBe(false);
	});
});

describe("createFileTokenStore", () => {
	it("round-trips a token through save/load", () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-github-auth-"));
		const path = join(dir, "token.json");
		try {
			const store = createFileTokenStore(path);
			expect(store.load()).toBeUndefined();
			store.save({ accessToken: "gho_x", tokenType: "bearer", scope: "repo", obtainedAt: 123 });
			expect(store.load()?.accessToken).toBe("gho_x");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("resolveGitHubToken / resolveStaticToken", () => {
	it("prefers a fresh stored device-flow token over the static PAT fallback", () => {
		const store = {
			load: () => ({ accessToken: "device-token", tokenType: "bearer", scope: "", obtainedAt: Date.now(), expiresInS: 3600 }),
			save: () => {},
			clear: () => {},
		};
		expect(resolveGitHubToken(store, { GITHUB_TOKEN: "pat-token" })).toBe("device-token");
	});

	it("falls back to the static PAT once the stored token is expired", () => {
		const store = {
			load: () => ({ accessToken: "device-token", tokenType: "bearer", scope: "", obtainedAt: Date.now() - 10_000, expiresInS: 5 }),
			save: () => {},
			clear: () => {},
		};
		expect(resolveGitHubToken(store, { GITHUB_TOKEN: "pat-token" })).toBe("pat-token");
	});

	it("resolveStaticToken checks GITHUB_TOKEN then GH_TOKEN", () => {
		expect(resolveStaticToken({ GITHUB_TOKEN: "a" })).toBe("a");
		expect(resolveStaticToken({ GH_TOKEN: "b" })).toBe("b");
		expect(resolveStaticToken({})).toBeUndefined();
	});
});

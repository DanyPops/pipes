import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createGitHubTokenStore,
	DeviceFlowDeniedError,
	DeviceFlowExpiredError,
	type FetchLike,
	pollDeviceAccessToken,
	requestDeviceCode,
	resolveStaticToken,
	runDeviceFlow,
} from "../../../src/adapters/github/auth.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("requestDeviceCode", () => {
	it("parses the device code response", async () => {
		const fetchImpl = (async () =>
			jsonResponse({
				device_code: "dc",
				user_code: "ABCD-1234",
				verification_uri: "https://github.com/login/device",
				expires_in: 900,
				interval: 5,
			})) as FetchLike;

		const result = await requestDeviceCode({ clientId: "client-1", fetchImpl });
		expect(result).toEqual({
			deviceCode: "dc",
			userCode: "ABCD-1234",
			verificationUri: "https://github.com/login/device",
			expiresInS: 900,
			intervalS: 5,
		});
	});

	it("throws on a non-ok response", async () => {
		const fetchImpl = (async () => new Response("", { status: 500 })) as FetchLike;
		await expect(requestDeviceCode({ clientId: "client-1", fetchImpl })).rejects.toThrow(/HTTP 500/);
	});
});

describe("pollDeviceAccessToken", () => {
	it("returns a token on success, with no expiresAt for a non-expiring GitHub OAuth App token", async () => {
		const fetchImpl = (async () => jsonResponse({ access_token: "gho_abc", token_type: "bearer", scope: "repo" })) as FetchLike;
		const token = await pollDeviceAccessToken({ clientId: "client-1", fetchImpl }, "dc");
		expect(token.accessToken).toBe("gho_abc");
		expect(token.expiresAt).toBeUndefined();
	});

	it("computes an ISO expiresAt from expires_in when the app has token expiry enabled", async () => {
		const fetchImpl = (async () =>
			jsonResponse({ access_token: "gho_abc", token_type: "bearer", scope: "repo", expires_in: 3600 })) as FetchLike;
		const before = Date.now();
		const token = await pollDeviceAccessToken({ clientId: "client-1", fetchImpl }, "dc");
		expect(token.expiresAt).toBeDefined();
		const expiresAtMs = new Date(token.expiresAt as string).getTime();
		expect(expiresAtMs).toBeGreaterThanOrEqual(before + 3600 * 1000);
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
				return jsonResponse({
					device_code: "dc",
					user_code: "ABCD-1234",
					verification_uri: "https://github.com/login/device",
					expires_in: 900,
					interval: 1,
				});
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
				return jsonResponse({
					device_code: "dc",
					user_code: "ABCD-1234",
					verification_uri: "https://github.com/login/device",
					expires_in: 0,
					interval: 1,
				});
			}
			return jsonResponse({ error: "authorization_pending" });
		}) as FetchLike;

		await expect(runDeviceFlow({ clientId: "client-1", fetchImpl, sleepImpl: async () => {}, onPrompt: () => {} })).rejects.toThrow(
			DeviceFlowExpiredError,
		);
	});
});

describe("createGitHubTokenStore", () => {
	it("round-trips a token through save/load, one file per profile-qualified backend name", () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-github-auth-"));
		try {
			const store = createGitHubTokenStore(dir, "github-work");
			expect(store.load()).toBeUndefined();
			store.save({ accessToken: "gho_x", scope: "repo" });
			expect(store.load()?.accessToken).toBe("gho_x");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps two profile-qualified backends in separate files, not colliding", () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-github-auth-"));
		try {
			createGitHubTokenStore(dir, "github").save({ accessToken: "personal-token" });
			createGitHubTokenStore(dir, "github-work").save({ accessToken: "work-token" });
			expect(createGitHubTokenStore(dir, "github").load()?.accessToken).toBe("personal-token");
			expect(createGitHubTokenStore(dir, "github-work").load()?.accessToken).toBe("work-token");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("resolveStaticToken", () => {
	it("checks GITHUB_TOKEN then GH_TOKEN", () => {
		expect(resolveStaticToken({ GITHUB_TOKEN: "a" })).toBe("a");
		expect(resolveStaticToken({ GH_TOKEN: "b" })).toBe("b");
		expect(resolveStaticToken({})).toBeUndefined();
	});
});

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "../../../src/adapters/github/auth.ts";
import {
	authenticate,
	buildAuthorizationUrl,
	createGitLabTokenStore,
	detectDeviceFlowSupport,
	DeviceFlowDeniedError,
	DeviceFlowExpiredError,
	exchangeAuthorizationCode,
	generatePkce,
	pollDeviceAccessToken,
	refreshAccessToken,
	requestDeviceCode,
	resolveStaticToken,
	runDeviceFlow,
	runPkceFlow,
	startCallbackServer,
} from "../../../src/adapters/gitlab/auth.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("generatePkce", () => {
	it("produces a challenge that is the base64url(sha256(verifier))", async () => {
		const { verifier, challenge } = generatePkce();
		const expected = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
			.toString("base64")
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		expect(challenge).toBe(expected);
	});

	it("generates a fresh verifier on every call", () => {
		expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
	});
});

describe("buildAuthorizationUrl", () => {
	it("includes PKCE and state parameters", () => {
		const url = buildAuthorizationUrl({
			baseUrl: "https://gitlab.example.com",
			clientId: "client-1",
			redirectUri: "http://127.0.0.1:9999/callback",
			state: "state-1",
			challenge: "challenge-1",
		});
		const parsed = new URL(url);
		expect(parsed.origin + parsed.pathname).toBe("https://gitlab.example.com/oauth/authorize");
		expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
		expect(parsed.searchParams.get("state")).toBe("state-1");
		expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:9999/callback");
	});
});

describe("startCallbackServer + runPkceFlow: real loopback listener, not mocked", () => {
	it("resolves the code and state from a real HTTP request to the callback URL", async () => {
		const server = startCallbackServer();
		try {
			const callbackPromise = server.waitForCallback();
			await fetch(`${server.redirectUri}?code=abc123&state=state-xyz`);
			const result = await callbackPromise;
			expect(result).toEqual({ ok: true, code: "abc123", state: "state-xyz" });
		} finally {
			server.close();
		}
	});

	it("resolves an error result, not a rejection, when GitLab redirects back with an error instead of a code", async () => {
		const server = startCallbackServer();
		try {
			const callbackPromise = server.waitForCallback();
			await fetch(`${server.redirectUri}?error=access_denied`);
			const result = await callbackPromise;
			expect(result).toEqual({ ok: false, error: "access_denied" });
		} finally {
			server.close();
		}
	});

	it("drives the full flow end to end: real listener, simulated browser redirect, mocked token exchange", async () => {
		const fetchImpl: FetchLike = async (url, init) => {
			expect(url).toContain("/oauth/token");
			expect(init?.body?.toString()).toContain("grant_type=authorization_code");
			return jsonResponse({ access_token: "glpat-real", token_type: "bearer", scope: "api" });
		};

		let capturedUrl = "";
		const flowPromise = runPkceFlow({
			baseUrl: "https://gitlab.example.com",
			clientId: "client-1",
			fetchImpl,
			onPrompt: (url) => {
				capturedUrl = url;
			},
		});

		// Simulate the browser following the authorization URL and GitLab
		// redirecting back with a real HTTP request to our local listener.
		await new Promise((resolve) => setTimeout(resolve, 5));
		const redirectUri = new URL(capturedUrl).searchParams.get("redirect_uri");
		const state = new URL(capturedUrl).searchParams.get("state");
		await fetch(`${redirectUri}?code=real-code&state=${state}`);

		const token = await flowPromise;
		expect(token.accessToken).toBe("glpat-real");
	});
});

describe("exchangeAuthorizationCode", () => {
	it("parses the token response", async () => {
		const fetchImpl: FetchLike = async () => jsonResponse({ access_token: "glpat-x", token_type: "bearer", scope: "api", expires_in: 7200 });
		const token = await exchangeAuthorizationCode({
			baseUrl: "https://gitlab.example.com",
			clientId: "c",
			redirectUri: "http://127.0.0.1:1/callback",
			code: "code",
			verifier: "verifier",
			fetchImpl,
		});
		expect(token.accessToken).toBe("glpat-x");
		expect(token.expiresAt).toBeDefined();
	});
});

describe("refreshAccessToken", () => {
	it("exchanges a refresh token for a new access token via grant_type=refresh_token", async () => {
		const fetchImpl: FetchLike = async (url, init) => {
			expect(url).toBe("https://gitlab.example.com/oauth/token");
			const body = init?.body?.toString() ?? "";
			expect(body).toContain("grant_type=refresh_token");
			expect(body).toContain("refresh_token=old-refresh");
			return jsonResponse({ access_token: "new-access", token_type: "bearer", scope: "api", refresh_token: "new-refresh", expires_in: 7200 });
		};
		const token = await refreshAccessToken({ baseUrl: "https://gitlab.example.com", clientId: "c", fetchImpl }, "old-refresh");
		expect(token.accessToken).toBe("new-access");
		expect(token.refreshToken).toBe("new-refresh");
		expect(token.expiresAt).toBeDefined();
	});

	it("keeps the current refresh token when GitLab's response omits a rotated one", async () => {
		const fetchImpl: FetchLike = async () => jsonResponse({ access_token: "new-access", token_type: "bearer", scope: "api", expires_in: 7200 });
		const token = await refreshAccessToken({ baseUrl: "https://gitlab.example.com", clientId: "c", fetchImpl }, "old-refresh");
		expect(token.refreshToken).toBe("old-refresh");
	});

	it("throws on a failed refresh rather than returning a malformed credential", async () => {
		const fetchImpl: FetchLike = async () => new Response("invalid_grant", { status: 400 });
		await expect(refreshAccessToken({ baseUrl: "https://gitlab.example.com", clientId: "c", fetchImpl }, "expired-refresh")).rejects.toThrow(
			/token refresh failed/,
		);
	});
});

describe("detectDeviceFlowSupport", () => {
	it("returns true when the endpoint exists (any non-404 response)", async () => {
		const fetchImpl: FetchLike = async () => jsonResponse({ error: "invalid_client" }, 400);
		expect(await detectDeviceFlowSupport({ baseUrl: "https://gitlab.example.com", clientId: "c", fetchImpl })).toBe(true);
	});

	it("returns false for a 404 (older self-managed instance without device grant)", async () => {
		const fetchImpl: FetchLike = async () => new Response("", { status: 404 });
		expect(await detectDeviceFlowSupport({ baseUrl: "https://old-gitlab.example.com", clientId: "c", fetchImpl })).toBe(false);
	});

	it("returns false rather than throwing on a network error", async () => {
		const fetchImpl: FetchLike = async () => {
			throw new Error("network unreachable");
		};
		expect(await detectDeviceFlowSupport({ baseUrl: "https://unreachable.example.com", clientId: "c", fetchImpl })).toBe(false);
	});
});

describe("device flow", () => {
	it("requestDeviceCode parses the response", async () => {
		const fetchImpl: FetchLike = async () =>
			jsonResponse({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://gitlab.example.com/oauth/device", expires_in: 900, interval: 5 });
		const result = await requestDeviceCode({ baseUrl: "https://gitlab.example.com", clientId: "c", fetchImpl });
		expect(result.userCode).toBe("ABCD-1234");
	});

	it("pollDeviceAccessToken throws DeviceFlowDeniedError for access_denied", async () => {
		const fetchImpl: FetchLike = async () => jsonResponse({ error: "access_denied" });
		await expect(pollDeviceAccessToken({ baseUrl: "https://gitlab.example.com", clientId: "c", fetchImpl }, "dc")).rejects.toThrow(DeviceFlowDeniedError);
	});

	it("runDeviceFlow polls through pending before succeeding", async () => {
		let call = 0;
		const fetchImpl: FetchLike = async (url) => {
			if (url.includes("authorize_device")) {
				return jsonResponse({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://gitlab.example.com/oauth/device", expires_in: 900, interval: 1 });
			}
			call++;
			return call === 1 ? jsonResponse({ error: "authorization_pending" }) : jsonResponse({ access_token: "glpat-final", token_type: "bearer", scope: "api" });
		};
		const token = await runDeviceFlow({ baseUrl: "https://gitlab.example.com", clientId: "c", fetchImpl, sleepImpl: async () => {}, onPrompt: () => {} });
		expect(token.accessToken).toBe("glpat-final");
	});

	it("runDeviceFlow throws DeviceFlowExpiredError once the device code expires", async () => {
		const fetchImpl: FetchLike = async (url) => {
			if (url.includes("authorize_device")) {
				return jsonResponse({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://gitlab.example.com/oauth/device", expires_in: 0, interval: 1 });
			}
			return jsonResponse({ error: "authorization_pending" });
		};
		await expect(
			runDeviceFlow({ baseUrl: "https://gitlab.example.com", clientId: "c", fetchImpl, sleepImpl: async () => {}, onPrompt: () => {} }),
		).rejects.toThrow(DeviceFlowExpiredError);
	});
});

describe("authenticate: prefers device flow, falls back to PKCE", () => {
	it("uses the device flow when the instance advertises oauth/authorize_device", async () => {
		let usedPkce = false;
		const fetchImpl: FetchLike = async (url) => {
			if (url.includes("authorize_device")) {
				return jsonResponse({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://gitlab.example.com/oauth/device", expires_in: 900, interval: 1 });
			}
			if (url.includes("oauth/token")) return jsonResponse({ access_token: "glpat-device", token_type: "bearer", scope: "api" });
			throw new Error(`unexpected: ${url}`);
		};

		const token = await authenticate({
			baseUrl: "https://gitlab.example.com",
			clientId: "c",
			fetchImpl,
			sleepImpl: async () => {},
			onDevicePrompt: () => {},
			onPkcePrompt: () => {
				usedPkce = true;
			},
		});
		expect(token.accessToken).toBe("glpat-device");
		expect(usedPkce).toBe(false);
	});

	it("falls back to PKCE when the instance has no device grant", async () => {
		let usedDevicePrompt = false;
		const fetchImpl: FetchLike = async (url) => {
			if (url.includes("authorize_device")) return new Response("", { status: 404 });
			if (url.includes("oauth/token")) return jsonResponse({ access_token: "glpat-pkce", token_type: "bearer", scope: "api" });
			throw new Error(`unexpected: ${url}`);
		};

		const flowPromise = authenticate({
			baseUrl: "https://old-gitlab.example.com",
			clientId: "c",
			fetchImpl,
			onDevicePrompt: () => {
				usedDevicePrompt = true;
			},
			onPkcePrompt: async (url) => {
				const redirectUri = new URL(url).searchParams.get("redirect_uri");
				const state = new URL(url).searchParams.get("state");
				await fetch(`${redirectUri}?code=pkce-code&state=${state}`);
			},
		});

		const token = await flowPromise;
		expect(token.accessToken).toBe("glpat-pkce");
		expect(usedDevicePrompt).toBe(false);
	});
});

describe("createGitLabTokenStore", () => {
	it("round-trips a token through save/load, one file per profile-qualified backend name", () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-gitlab-auth-"));
		try {
			const store = createGitLabTokenStore(dir, "gitlab-work");
			expect(store.load()).toBeUndefined();
			store.save({ accessToken: "glpat-y", scope: "api" });
			expect(store.load()?.accessToken).toBe("glpat-y");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps two profile-qualified backends in separate files, not colliding", () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-gitlab-auth-"));
		try {
			createGitLabTokenStore(dir, "gitlab").save({ accessToken: "default-token" });
			createGitLabTokenStore(dir, "gitlab-work").save({ accessToken: "work-token" });
			expect(createGitLabTokenStore(dir, "gitlab").load()?.accessToken).toBe("default-token");
			expect(createGitLabTokenStore(dir, "gitlab-work").load()?.accessToken).toBe("work-token");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("resolveStaticToken", () => {
	it("falls back to PRIVATE_TOKEN then GITLAB_TOKEN for the static PAT", () => {
		expect(resolveStaticToken({ GITLAB_TOKEN: "a" })).toBe("a");
		expect(resolveStaticToken({ PRIVATE_TOKEN: "b" })).toBe("b");
		expect(resolveStaticToken({})).toBeUndefined();
	});
});

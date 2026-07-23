/**
 * GitLab authentication. Two real delegated flows exist depending on the
 * instance:
 *  - Device Authorization Grant, when the instance advertises
 *    oauth/authorize_device (GitLab.com and sufficiently recent
 *    self-managed instances) — no local listener needed, works headless.
 *  - Authorization Code + PKCE via a short-lived local loopback callback
 *    listener otherwise — works on any instance with OAuth enabled,
 *    including older self-managed ones that predate the device grant.
 * A static PAT is the last-resort fallback for instances too old for
 * either, documented as an exception rather than a default.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FetchLike } from "../github/auth.ts";

export interface GitLabAuthOptions {
	baseUrl: string;
	clientId: string;
	scope?: string;
	fetchImpl?: FetchLike;
}

export interface AccessToken {
	accessToken: string;
	tokenType: string;
	scope: string;
	refreshToken?: string;
	expiresInS?: number;
	obtainedAt: number;
}

function trimBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/$/, "");
}

// ── PKCE ─────────────────────────────────────────────────────────────────────

export interface PkceCodes {
	verifier: string;
	challenge: string;
}

function base64Url(input: Buffer): string {
	return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generatePkce(): PkceCodes {
	const verifier = base64Url(randomBytes(32));
	const challenge = base64Url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

export function buildAuthorizationUrl(options: GitLabAuthOptions & { redirectUri: string; state: string; challenge: string }): string {
	const params = new URLSearchParams({
		client_id: options.clientId,
		redirect_uri: options.redirectUri,
		response_type: "code",
		state: options.state,
		code_challenge: options.challenge,
		code_challenge_method: "S256",
		...(options.scope ? { scope: options.scope } : {}),
	});
	return `${trimBaseUrl(options.baseUrl)}/oauth/authorize?${params}`;
}

export type CallbackResult = { ok: true; code: string; state: string } | { ok: false; error: string };

export interface CallbackServer {
	redirectUri: string;
	/** Resolves, never rejects — an OAuth error or a malformed callback is a result, not an exception, so nothing can become an unhandled rejection if the caller hasn't awaited yet. */
	waitForCallback(): Promise<CallbackResult>;
	close(): void;
}

/** Binds loopback:0 (an OS-assigned port), matching daemon-kit's loopback-only convention for anything listening locally. */
export function startCallbackServer(): CallbackServer {
	let resolveCallback: (result: CallbackResult) => void;
	const waiter = new Promise<CallbackResult>((resolve) => {
		resolveCallback = resolve;
	});

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname !== "/callback") return new Response("not found", { status: 404 });
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			const error = url.searchParams.get("error");
			if (error) {
				resolveCallback({ ok: false, error });
				return new Response(`<html><body>Authorization failed: ${error}. You can close this tab.</body></html>`, { headers: { "content-type": "text/html" } });
			}
			if (!code || !state) {
				resolveCallback({ ok: false, error: "missing code or state" });
				return new Response("<html><body>Missing code or state.</body></html>", { status: 400, headers: { "content-type": "text/html" } });
			}
			resolveCallback({ ok: true, code, state });
			return new Response("<html><body>Authorized. You can close this tab.</body></html>", { headers: { "content-type": "text/html" } });
		},
	});

	return {
		redirectUri: `http://127.0.0.1:${server.port}/callback`,
		waitForCallback: () => waiter,
		// Graceful (non-forced) stop: the callback response was just handed to Bun's
		// HTTP layer synchronously on return, but a forced stop still risks racing
		// the socket flush on a fast local loop — seen as a real ECONNRESET under test.
		close: () => void server.stop(),
	};
}

export async function exchangeAuthorizationCode(
	options: GitLabAuthOptions & { redirectUri: string; code: string; verifier: string },
): Promise<AccessToken> {
	const doFetch = options.fetchImpl ?? fetch;
	const response = await doFetch(`${trimBaseUrl(options.baseUrl)}/oauth/token`, {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: options.clientId,
			code: options.code,
			grant_type: "authorization_code",
			redirect_uri: options.redirectUri,
			code_verifier: options.verifier,
		}),
	});
	if (!response.ok) throw new Error(`GitLab token exchange failed: HTTP ${response.status}`);
	const body = (await response.json()) as { access_token: string; token_type: string; scope?: string; refresh_token?: string; expires_in?: number };
	return {
		accessToken: body.access_token,
		tokenType: body.token_type,
		scope: body.scope ?? "",
		refreshToken: body.refresh_token,
		expiresInS: body.expires_in,
		obtainedAt: Date.now(),
	};
}

/** GitLab issues real refresh tokens (unlike GitHub OAuth Apps' device flow, which never expires and has none) — required for the token provider's proactive refresh. */
export async function refreshAccessToken(options: GitLabAuthOptions, refreshToken: string): Promise<AccessToken> {
	const doFetch = options.fetchImpl ?? fetch;
	const response = await doFetch(`${trimBaseUrl(options.baseUrl)}/oauth/token`, {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: options.clientId, refresh_token: refreshToken, grant_type: "refresh_token" }),
	});
	if (!response.ok) throw new Error(`GitLab token refresh failed: HTTP ${response.status}`);
	const body = (await response.json()) as { access_token: string; token_type: string; scope?: string; refresh_token?: string; expires_in?: number };
	return {
		accessToken: body.access_token,
		tokenType: body.token_type,
		scope: body.scope ?? "",
		// GitLab rotates refresh tokens on use; fall back to the current one only if the response omits a new one.
		refreshToken: body.refresh_token ?? refreshToken,
		expiresInS: body.expires_in,
		obtainedAt: Date.now(),
	};
}

export interface RunPkceFlowOptions extends GitLabAuthOptions {
	onPrompt: (authorizationUrl: string) => void;
}

/** Drives the full PKCE flow: start the local callback listener, prompt the user with the authorization URL, wait, exchange, close. */
export async function runPkceFlow(options: RunPkceFlowOptions): Promise<AccessToken> {
	const { verifier, challenge } = generatePkce();
	const state = base64Url(randomBytes(16));
	const server = startCallbackServer();
	try {
		const authorizationUrl = buildAuthorizationUrl({ ...options, redirectUri: server.redirectUri, state, challenge });
		options.onPrompt(authorizationUrl);
		const result = await server.waitForCallback();
		if (!result.ok) throw new Error(`GitLab authorization failed: ${result.error}`);
		if (result.state !== state) throw new Error("GitLab callback state mismatch — possible CSRF, aborting");
		return await exchangeAuthorizationCode({ ...options, redirectUri: server.redirectUri, code: result.code, verifier });
	} finally {
		server.close();
	}
}

// ── Device flow (used only when the instance advertises it) ────────────────

export interface DeviceCodeResponse {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	expiresInS: number;
	intervalS: number;
}

export class DeviceFlowPendingError extends Error {
	constructor() {
		super("authorization pending");
	}
}
export class DeviceFlowSlowDownError extends Error {
	constructor(public readonly newIntervalS: number) {
		super("slow down");
	}
}
export class DeviceFlowExpiredError extends Error {
	constructor() {
		super("device code expired");
	}
}
export class DeviceFlowDeniedError extends Error {
	constructor() {
		super("user denied the authorization request");
	}
}

/** Probes for oauth/authorize_device support rather than assuming it — only sufficiently recent GitLab instances have it. */
export async function detectDeviceFlowSupport(options: GitLabAuthOptions): Promise<boolean> {
	const doFetch = options.fetchImpl ?? fetch;
	try {
		const response = await doFetch(`${trimBaseUrl(options.baseUrl)}/oauth/authorize_device`, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ client_id: options.clientId }),
		});
		// A real device endpoint responds with a device_code payload (or a
		// scope/validation error) even for a bad body — a 404 means the
		// endpoint (and therefore the feature) doesn't exist on this instance.
		return response.status !== 404;
	} catch {
		return false;
	}
}

export async function requestDeviceCode(options: GitLabAuthOptions): Promise<DeviceCodeResponse> {
	const doFetch = options.fetchImpl ?? fetch;
	const response = await doFetch(`${trimBaseUrl(options.baseUrl)}/oauth/authorize_device`, {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: options.clientId, ...(options.scope ? { scope: options.scope } : {}) }),
	});
	if (!response.ok) throw new Error(`GitLab device code request failed: HTTP ${response.status}`);
	const body = (await response.json()) as { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number };
	return { deviceCode: body.device_code, userCode: body.user_code, verificationUri: body.verification_uri, expiresInS: body.expires_in, intervalS: body.interval };
}

export async function pollDeviceAccessToken(options: GitLabAuthOptions, deviceCode: string): Promise<AccessToken> {
	const doFetch = options.fetchImpl ?? fetch;
	const response = await doFetch(`${trimBaseUrl(options.baseUrl)}/oauth/token`, {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: options.clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
	});
	const body = (await response.json()) as {
		error?: string;
		interval?: number;
		access_token?: string;
		token_type?: string;
		scope?: string;
		refresh_token?: string;
		expires_in?: number;
	};
	if (body.error) {
		switch (body.error) {
			case "authorization_pending":
				throw new DeviceFlowPendingError();
			case "slow_down":
				throw new DeviceFlowSlowDownError(body.interval ?? 10);
			case "expired_token":
				throw new DeviceFlowExpiredError();
			case "access_denied":
				throw new DeviceFlowDeniedError();
			default:
				throw new Error(`GitLab device flow error: ${body.error}`);
		}
	}
	if (!body.access_token) throw new Error("GitLab device flow response missing access_token");
	return {
		accessToken: body.access_token,
		tokenType: body.token_type ?? "bearer",
		scope: body.scope ?? "",
		refreshToken: body.refresh_token,
		expiresInS: body.expires_in,
		obtainedAt: Date.now(),
	};
}

export interface RunDeviceFlowOptions extends GitLabAuthOptions {
	onPrompt: (info: DeviceCodeResponse) => void;
	sleepImpl?: (ms: number) => Promise<void>;
}

export async function runDeviceFlow(options: RunDeviceFlowOptions): Promise<AccessToken> {
	const sleep = options.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const codeResponse = await requestDeviceCode(options);
	options.onPrompt(codeResponse);

	let intervalS = codeResponse.intervalS || 5;
	const deadline = Date.now() + codeResponse.expiresInS * 1000;
	while (Date.now() < deadline) {
		await sleep(intervalS * 1000);
		try {
			return await pollDeviceAccessToken(options, codeResponse.deviceCode);
		} catch (error) {
			if (error instanceof DeviceFlowPendingError) continue;
			if (error instanceof DeviceFlowSlowDownError) {
				intervalS = error.newIntervalS;
				continue;
			}
			throw error;
		}
	}
	throw new DeviceFlowExpiredError();
}

// ── Top-level: prefer device flow when available, else PKCE ────────────────

export interface AuthenticateOptions extends GitLabAuthOptions {
	onDevicePrompt: (info: DeviceCodeResponse) => void;
	onPkcePrompt: (authorizationUrl: string) => void;
	sleepImpl?: (ms: number) => Promise<void>;
}

export async function authenticate(options: AuthenticateOptions): Promise<AccessToken> {
	const deviceFlowSupported = await detectDeviceFlowSupport(options);
	if (deviceFlowSupported) {
		return runDeviceFlow({ ...options, onPrompt: options.onDevicePrompt });
	}
	return runPkceFlow({ ...options, onPrompt: options.onPkcePrompt });
}

export function isTokenExpired(token: AccessToken): boolean {
	if (token.expiresInS === undefined) return false;
	return Date.now() >= token.obtainedAt + token.expiresInS * 1000;
}

export interface TokenStore {
	load(): AccessToken | undefined;
	save(token: AccessToken): void;
	clear(): void;
}

export function createFileTokenStore(path: string): TokenStore {
	return {
		load(): AccessToken | undefined {
			if (!existsSync(path)) return undefined;
			try {
				return JSON.parse(readFileSync(path, "utf8")) as AccessToken;
			} catch {
				return undefined;
			}
		},
		save(token: AccessToken): void {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			writeFileSync(path, JSON.stringify(token), { mode: 0o600 });
			chmodSync(path, 0o600);
		},
		clear(): void {
			if (existsSync(path)) writeFileSync(path, "");
		},
	};
}

/** Documented fallback for self-managed instances too old for either delegated flow, or users who prefer a static token. */
export function resolveStaticToken(env: Record<string, string | undefined> = process.env): string | undefined {
	return env.GITLAB_TOKEN || env.PRIVATE_TOKEN || undefined;
}

export function resolveGitLabToken(store: TokenStore, env: Record<string, string | undefined> = process.env): string | undefined {
	const stored = store.load();
	if (stored && !isTokenExpired(stored)) return stored.accessToken;
	return resolveStaticToken(env);
}

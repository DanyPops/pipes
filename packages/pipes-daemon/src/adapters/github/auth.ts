/**
 * GitHub authentication: OAuth 2.0 Device Authorization Grant as the
 * primary path (no client secret needed, works for a CLI/TUI with no
 * browser redirect), with a static PAT as an explicit, documented
 * fallback for users who prefer it. Prefer the device flow wherever
 * possible rather than asking for a pasted token.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEFAULT_POLL_INTERVAL_S = 5;

/** Narrower than `typeof fetch` so a plain test double doesn't need to satisfy Bun's full fetch shape (e.g. preconnect). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface DeviceCodeResponse {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	expiresInS: number;
	intervalS: number;
}

export interface AccessToken {
	accessToken: string;
	tokenType: string;
	scope: string;
	/** Present only when the GitHub App has "expire user tokens" enabled. */
	refreshToken?: string;
	expiresInS?: number;
	refreshTokenExpiresInS?: number;
	/** When this token was obtained, for expiresInS-relative expiry checks. */
	obtainedAt: number;
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

export interface GitHubAuthOptions {
	clientId: string;
	scope?: string;
	fetchImpl?: FetchLike;
}

export async function requestDeviceCode(options: GitHubAuthOptions): Promise<DeviceCodeResponse> {
	const doFetch = options.fetchImpl ?? fetch;
	const response = await doFetch(DEVICE_CODE_URL, {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: options.clientId, ...(options.scope ? { scope: options.scope } : {}) }),
	});
	if (!response.ok) throw new Error(`GitHub device code request failed: HTTP ${response.status}`);
	const body = (await response.json()) as {
		device_code: string;
		user_code: string;
		verification_uri: string;
		expires_in: number;
		interval: number;
	};
	return {
		deviceCode: body.device_code,
		userCode: body.user_code,
		verificationUri: body.verification_uri,
		expiresInS: body.expires_in,
		intervalS: body.interval,
	};
}

/** One poll attempt. Throws a typed error for pending/slow_down/expired/denied so callers can drive their own loop. */
export async function pollDeviceAccessToken(options: GitHubAuthOptions, deviceCode: string): Promise<AccessToken> {
	const doFetch = options.fetchImpl ?? fetch;
	const response = await doFetch(ACCESS_TOKEN_URL, {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: options.clientId,
			device_code: deviceCode,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		}),
	});
	const body = (await response.json()) as {
		error?: string;
		interval?: number;
		access_token?: string;
		token_type?: string;
		scope?: string;
		refresh_token?: string;
		expires_in?: number;
		refresh_token_expires_in?: number;
	};

	if (body.error) {
		switch (body.error) {
			case "authorization_pending":
				throw new DeviceFlowPendingError();
			case "slow_down":
				throw new DeviceFlowSlowDownError(body.interval ?? DEFAULT_POLL_INTERVAL_S * 2);
			case "expired_token":
				throw new DeviceFlowExpiredError();
			case "access_denied":
				throw new DeviceFlowDeniedError();
			default:
				throw new Error(`GitHub device flow error: ${body.error}`);
		}
	}
	if (!body.access_token) throw new Error("GitHub device flow response missing access_token");

	return {
		accessToken: body.access_token,
		tokenType: body.token_type ?? "bearer",
		scope: body.scope ?? "",
		refreshToken: body.refresh_token,
		expiresInS: body.expires_in,
		refreshTokenExpiresInS: body.refresh_token_expires_in,
		obtainedAt: Date.now(),
	};
}

export interface RunDeviceFlowOptions extends GitHubAuthOptions {
	onPrompt: (info: DeviceCodeResponse) => void;
	/** Overridable for tests; production default follows the interval GitHub returns. */
	sleepImpl?: (ms: number) => Promise<void>;
}

/** Drives the full device flow: request a code, show it to the user, then poll until success, expiry, or denial. */
export async function runDeviceFlow(options: RunDeviceFlowOptions): Promise<AccessToken> {
	const sleep = options.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const codeResponse = await requestDeviceCode(options);
	options.onPrompt(codeResponse);

	let intervalS = codeResponse.intervalS || DEFAULT_POLL_INTERVAL_S;
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

export function isTokenExpired(token: AccessToken): boolean {
	if (token.expiresInS === undefined) return false; // non-expiring token (app has expiry disabled)
	return Date.now() >= token.obtainedAt + token.expiresInS * 1000;
}

export interface TokenStore {
	load(): AccessToken | undefined;
	save(token: AccessToken): void;
	clear(): void;
}

/** Persists the device-flow token as JSON at 0600, mirroring daemon-kit's auth-token file convention. */
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

/** Documented fallback for users who prefer a static token, or environments with no interactive prompt available — not the primary path. */
export function resolveStaticToken(env: Record<string, string | undefined> = process.env): string | undefined {
	return env.GITHUB_TOKEN || env.GH_TOKEN || undefined;
}

/** Resolves a usable token: a stored/fresh device-flow token first, then the static PAT fallback, else undefined. */
export function resolveGitHubToken(store: TokenStore, env: Record<string, string | undefined> = process.env): string | undefined {
	const stored = store.load();
	if (stored && !isTokenExpired(stored)) return stored.accessToken;
	return resolveStaticToken(env);
}

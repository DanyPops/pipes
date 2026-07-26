/**
 * Jenkins authentication: Basic Auth with username + API token, the only
 * option Jenkins' remote API offers — there is no delegated-auth flow to
 * prefer here. This is the one backend where a static credential is not a
 * fallback but the actual primary path, documented plainly rather than
 * pretending otherwise.
 *
 * Every mutating request needs a CSRF crumb. Jenkins >= 2.176.2 exempts
 * API-token-authenticated requests from crumb checks by default, but that
 * cannot be assumed for older or differently configured instances, so a
 * crumb is always fetched and attached defensively rather than skipped.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TryEnigmaVaultCredential } from "../enigma-source.ts";
import { tryEnigmaVaultCredential } from "../enigma-source.ts";
import type { FetchLike } from "../github/auth.ts";

export interface JenkinsCredentials {
	baseUrl: string;
	username: string;
	apiToken: string;
}

export interface CrumbInfo {
	field: string;
	value: string;
}

export interface CrumbCache {
	get(): CrumbInfo | undefined;
	set(info: CrumbInfo | undefined): void;
}

/** In-memory only — a crumb is tied to the session that fetched it, not worth persisting across daemon restarts. */
export function createCrumbCache(): CrumbCache {
	let cached: CrumbInfo | undefined;
	return {
		get: () => cached,
		set: (info) => {
			cached = info;
		},
	};
}

export function basicAuthHeader(credentials: JenkinsCredentials): string {
	return `Basic ${Buffer.from(`${credentials.username}:${credentials.apiToken}`).toString("base64")}`;
}

/** Returns undefined (not an error) when the crumb issuer is disabled or absent — not every instance requires one. */
export async function fetchCrumb(credentials: JenkinsCredentials, fetchImpl: FetchLike): Promise<CrumbInfo | undefined> {
	const response = await fetchImpl(`${credentials.baseUrl.replace(/\/$/, "")}/crumbIssuer/api/json`, {
		headers: { authorization: basicAuthHeader(credentials) },
	});
	if (!response.ok) return undefined;
	const body = (await response.json()) as { crumb?: string; crumbRequestField?: string };
	if (!body.crumb || !body.crumbRequestField) return undefined;
	return { field: body.crumbRequestField, value: body.crumb };
}

/** Attaches Authorization and (if available) a cached-or-freshly-fetched crumb header to a mutating request. */
export async function withCrumbHeaders(
	credentials: JenkinsCredentials,
	cache: CrumbCache,
	fetchImpl: FetchLike,
	baseHeaders: Record<string, string> = {},
): Promise<Record<string, string>> {
	let crumb = cache.get();
	if (!crumb) {
		crumb = await fetchCrumb(credentials, fetchImpl);
		cache.set(crumb);
	}
	return {
		...baseHeaders,
		authorization: basicAuthHeader(credentials),
		...(crumb ? { [crumb.field]: crumb.value } : {}),
	};
}

export interface CredentialStore {
	load(): JenkinsCredentials | undefined;
	save(credentials: JenkinsCredentials): void;
	clear(): void;
}

/**
 * Same 0600/0700 file convention as daemon-kit's ensureAuthToken, adapted
 * for a user-supplied username+token pair rather than a daemon-generated
 * random bearer token — daemon-kit's helper always mints a fresh token on
 * first read, which is wrong for a credential the user must provide.
 */
export function createFileCredentialStore(path: string): CredentialStore {
	return {
		load(): JenkinsCredentials | undefined {
			if (!existsSync(path)) return undefined;
			try {
				return JSON.parse(readFileSync(path, "utf8")) as JenkinsCredentials;
			} catch {
				return undefined;
			}
		},
		save(credentials: JenkinsCredentials): void {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			writeFileSync(path, JSON.stringify(credentials), { mode: 0o600 });
			chmodSync(path, 0o600);
		},
		clear(): void {
			if (existsSync(path)) writeFileSync(path, "");
		},
	};
}

/**
 * Resolves credentials: a running Enigma vault first (optional, additive --
 * see ../enigma-source.ts), then the environment, then a stored file. There
 * is no delegated OAuth option for Jenkins itself, but Enigma's own Jenkins
 * login (a static username+API-token pair, the same real primary path this
 * file documents) can still be the source of truth when configured -- url
 * and username live in the stored credential's `extra` field, matching
 * enigma's own mapCredentialToEnv shape for Jenkins.
 */
export async function resolveJenkinsCredentials(
	store: CredentialStore,
	env: Record<string, string | undefined> = process.env,
	tryEnigma: TryEnigmaVaultCredential = tryEnigmaVaultCredential,
): Promise<JenkinsCredentials | undefined> {
	const fromEnigma = await tryEnigma("jenkins", { env });
	if (fromEnigma?.extra?.url && fromEnigma.extra?.username) {
		return { baseUrl: fromEnigma.extra.url, username: fromEnigma.extra.username, apiToken: fromEnigma.accessToken };
	}

	if (env.JENKINS_URL && env.JENKINS_USER && env.JENKINS_API_TOKEN) {
		return { baseUrl: env.JENKINS_URL, username: env.JENKINS_USER, apiToken: env.JENKINS_API_TOKEN };
	}
	return store.load();
}

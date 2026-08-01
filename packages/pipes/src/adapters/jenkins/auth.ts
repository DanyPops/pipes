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

import type { TryEnigmaCredential } from "@danypops/enigma-client";
import { tryEnigmaCredential } from "@danypops/enigma-client";
import { createFileStore, type RefreshableAccessToken } from "@danypops/vehicle-server/vault";
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
}

function toAccessToken(credentials: JenkinsCredentials): RefreshableAccessToken {
	return { accessToken: credentials.apiToken, extra: { baseUrl: credentials.baseUrl, username: credentials.username } };
}

function fromAccessToken(token: RefreshableAccessToken): JenkinsCredentials | undefined {
	const baseUrl = token.extra?.baseUrl;
	const username = token.extra?.username;
	if (!baseUrl || !username) return undefined;
	return { baseUrl, username, apiToken: token.accessToken };
}

/**
 * Jenkins credentials never expire and have nothing to refresh, so vehicle-server's
 * createFileStore is used purely for its atomic-write/0600 file mechanics -- the
 * apiToken/baseUrl/username triple is encoded into/out of RefreshableAccessToken's
 * generic accessToken+extra shape at this boundary, one file per profile-qualified
 * backend name (see paths.ts's profiledBackend()).
 */
export function createFileCredentialStore(credentialsDir: string, backend: string): CredentialStore {
	const fileStore = createFileStore<RefreshableAccessToken>(credentialsDir, backend);
	return {
		load: () => {
			const token = fileStore.load();
			return token ? fromAccessToken(token) : undefined;
		},
		save: (credentials) => fileStore.save(toAccessToken(credentials)),
	};
}

/**
 * Resolves credentials: a running Enigma vault first (optional, additive --
 * see @danypops/enigma-client), then the environment, then a stored file.
 * There is no delegated OAuth option for Jenkins itself, but Enigma's own
 * Jenkins login (a static username+API-token pair, the same real primary
 * path this file documents) can still be the source of truth when
 * configured -- url and username live in the stored credential's `extra`
 * field. Used for the single-instance legacy default only -- a named
 * repos.json target uses resolveJenkinsCredentialsForBaseUrl instead.
 */
export async function resolveJenkinsCredentials(
	store: CredentialStore,
	env: Record<string, string | undefined> = process.env,
	tryEnigma: TryEnigmaCredential = tryEnigmaCredential,
): Promise<JenkinsCredentials | undefined> {
	// ENIGMA_CLIENT_TOKEN is this daemon's own registered-client token (`enigma client
	// add pipes --backends ...`), scoped to exactly the backends pipes needs -- preferred
	// over Enigma's shared admin-token file, which grants every vaulted backend.
	const fromEnigma = await tryEnigma("jenkins", { env, token: env.ENIGMA_CLIENT_TOKEN });
	if (fromEnigma?.extra?.url && fromEnigma.extra?.username) {
		return { baseUrl: fromEnigma.extra.url, username: fromEnigma.extra.username, apiToken: fromEnigma.accessToken };
	}

	if (env.JENKINS_URL && env.JENKINS_USER && env.JENKINS_API_TOKEN) {
		return { baseUrl: env.JENKINS_URL, username: env.JENKINS_USER, apiToken: env.JENKINS_API_TOKEN };
	}
	return store.load();
}

/**
 * Used only when repos.json names explicit Jenkins targets -- env.JENKINS_URL is the
 * single-instance legacy default's own signal, not consulted here, since multiple named
 * targets can't share one ambient env triple (which of two Jenkins servers would it mean?).
 * Asks Enigma for the exact same name (e.g. "prod-jenkins") this target's local store
 * uses as its own filename -- unlike github/gitlab, a Jenkins profile IS the literal
 * backend name here (see config.ts), not a suffix on a shared default, so the Enigma
 * alias asked for matches it directly rather than through profiledBackend(). Still
 * verified against this target's own baseUrl before being trusted: a stale or
 * misconfigured alias pointing at the wrong server is caught here rather than silently
 * authenticating against the wrong Jenkins instance.
 */
export async function resolveJenkinsCredentialsForBaseUrl(
	store: CredentialStore,
	baseUrl: string,
	profile: string,
	env: Record<string, string | undefined> = process.env,
	tryEnigma: TryEnigmaCredential = tryEnigmaCredential,
): Promise<JenkinsCredentials | undefined> {
	const fromEnigma = await tryEnigma(profile, { env, token: env.ENIGMA_CLIENT_TOKEN });
	if (fromEnigma?.extra?.url === baseUrl && fromEnigma.extra?.username) {
		return { baseUrl, username: fromEnigma.extra.username, apiToken: fromEnigma.accessToken };
	}
	return store.load();
}

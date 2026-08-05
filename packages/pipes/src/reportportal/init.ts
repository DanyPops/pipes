/**
 * Report Portal credential resolution + adapter construction. Report Portal
 * has no delegated-auth option -- like Jenkins (see auth/jenkins-auth.ts), a
 * static API key is the documented primary path here, not a fallback.
 * Deliberately not folded into config.ts's buildConfiguredAdapters(), which
 * returns CIBackend[] only -- Report Portal is a LaunchBackend, a different
 * port entirely (see launch-backend.ts).
 */
import type { TryEnigmaCredential } from "@danypops/enigma-client";
import { tryEnigmaCredential } from "@danypops/enigma-client";
import type { RefreshableAccessToken } from "@danypops/vehicle-server/vault";
import { createFileStore } from "@danypops/vehicle-server/vault";
import type { PipesCredentialPaths } from "../paths.ts";
import type { LaunchBackend } from "./launch-backend.ts";
import { createReportPortalAdapter } from "./reportportal.ts";

export interface ReportPortalCredentials {
	baseUrl: string;
	project: string;
	apiKey: string;
}

export interface ReportPortalCredentialStore {
	load(): ReportPortalCredentials | undefined;
	save(credentials: ReportPortalCredentials): void;
}

function toAccessToken(credentials: ReportPortalCredentials): RefreshableAccessToken {
	return { accessToken: credentials.apiKey, extra: { url: credentials.baseUrl, project: credentials.project } };
}

function fromAccessToken(token: RefreshableAccessToken): ReportPortalCredentials | undefined {
	const baseUrl = token.extra?.url;
	const project = token.extra?.project;
	if (!baseUrl || !project) return undefined;
	return { baseUrl, project, apiKey: token.accessToken };
}

/**
 * Report Portal credentials never expire and have nothing to refresh, so
 * vehicle-server's createFileStore is used purely for its atomic-write/0600
 * file mechanics -- the same pattern jenkins-auth.ts's own
 * createFileCredentialStore uses, encoding this backend's own
 * apiKey/baseUrl/project triple into RefreshableAccessToken's generic
 * accessToken+extra shape at this boundary.
 */
export function createFileCredentialStore(credentialsDir: string, backend: string): ReportPortalCredentialStore {
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
 * Resolves credentials: a running Enigma vault first (optional, additive),
 * then RP_URL/RP_PROJECT/RP_API_KEY (names kept from emcee's own init.go for
 * continuity with existing operator muscle memory), then a stored file.
 * Returns undefined (not a throw) when nothing resolves -- "not configured"
 * is a normal, expected state for a backend the caller might not have set
 * up, matching both emcee's init.go and resolveJenkinsCredentials's own
 * contract.
 */
export async function resolveReportPortalCredentials(
	store: ReportPortalCredentialStore,
	env: Record<string, string | undefined> = process.env,
	tryEnigma: TryEnigmaCredential = tryEnigmaCredential,
): Promise<ReportPortalCredentials | undefined> {
	// ENIGMA_CLIENT_TOKEN is this daemon's own registered-client token, scoped to exactly the
	// backends pipes needs -- preferred over Enigma's shared admin-token file, matching every
	// other backend's own Enigma lookup in this package.
	const fromEnigma = await tryEnigma("reportportal", { env, token: env.ENIGMA_CLIENT_TOKEN });
	if (fromEnigma?.extra?.url && fromEnigma.extra?.project) {
		return { baseUrl: fromEnigma.extra.url, project: fromEnigma.extra.project, apiKey: fromEnigma.accessToken };
	}

	if (env.RP_URL && env.RP_PROJECT && env.RP_API_KEY) {
		return { baseUrl: env.RP_URL, project: env.RP_PROJECT, apiKey: env.RP_API_KEY };
	}
	return store.load();
}

/**
 * Ties credential resolution to adapter construction -- the daemon's own
 * entry point for wiring up Report Portal, mirroring config.ts's role for
 * CIBackend adapters but returning a single optional LaunchBackend instead
 * of a list (Report Portal is one instance, not a multi-target registry the
 * way github/gitlab/jenkins repos.json is).
 */
export async function buildConfiguredReportPortalAdapter(
	credentialPaths: PipesCredentialPaths,
	env: Record<string, string | undefined> = process.env,
	tryEnigma: TryEnigmaCredential = tryEnigmaCredential,
): Promise<LaunchBackend | undefined> {
	const credentials = await resolveReportPortalCredentials(
		createFileCredentialStore(credentialPaths.credentialsDir, "reportportal"),
		env,
		tryEnigma,
	);
	if (!credentials) return undefined;
	return createReportPortalAdapter({
		name: "reportportal",
		baseUrl: credentials.baseUrl,
		project: credentials.project,
		token: credentials.apiKey,
	});
}

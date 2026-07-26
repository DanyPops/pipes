/**
 * Resolves configured CI backends from environment + on-disk credential
 * stores. Each backend is entirely optional — the daemon boots fine with
 * zero, one, two, or three configured (no eager network probing either
 * way, since none of the three adapter constructors do I/O). Unconfigured
 * backends are still reported via BackendInfo so ci.help lists all three
 * backend types even when only some are usable right now.
 */
import type { BackendInfo } from "../domain/backend.ts";
import type { CIBackend } from "../ports/ci-backend.ts";
import type { PipesCredentialPaths } from "../paths.ts";
import { tryEnigmaCredential } from "./enigma-source.ts";
import { createFileTokenStore as createGitHubTokenStore, resolveStaticToken as resolveStaticGitHubToken } from "./github/auth.ts";
import { createGitHubAdapter } from "./github/github-adapter.ts";
import { createFileTokenStore as createGitLabTokenStore, refreshAccessToken as refreshGitLabToken, resolveStaticToken as resolveStaticGitLabToken } from "./gitlab/auth.ts";
import { createGitLabAdapter } from "./gitlab/gitlab-adapter.ts";
import { createFileCredentialStore, resolveJenkinsCredentials } from "./jenkins/auth.ts";
import { createJenkinsAdapter } from "./jenkins/jenkins-adapter.ts";
import { createTokenProvider } from "./token-provider.ts";

export interface ConfiguredBackends {
	adapters: CIBackend[];
	unconfigured: BackendInfo[];
}

export async function buildConfiguredAdapters(
	credentialPaths: PipesCredentialPaths,
	env: Record<string, string | undefined> = process.env,
	tryEnigma: typeof tryEnigmaCredential = tryEnigmaCredential,
): Promise<ConfiguredBackends> {
	const adapters: CIBackend[] = [];
	const unconfigured: BackendInfo[] = [];

	// Login (device flow / PKCE) writes to these same store files; a token provider
	// re-reads on every call, so a freshly logged-in or refreshed credential is picked
	// up by an already-running daemon without needing a restart or adapter rebuild.
	if (env.GITHUB_OWNER && env.GITHUB_REPO) {
		// GitHub OAuth Apps' device flow never issues a refresh token (confirmed against
		// GitHub's own docs: the device-flow token response has no refresh_token field,
		// and refresh is a GitHub-App-only feature) — no refresh function to pass.
		const getToken = createTokenProvider({
			store: createGitHubTokenStore(credentialPaths.githubToken),
			staticFallback: () => resolveStaticGitHubToken(env),
			enigmaSource: () => tryEnigma("github", { env }),
		});
		adapters.push(createGitHubAdapter({ name: "github", owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO, getToken }));
	} else {
		unconfigured.push({ name: "github", type: "github" });
	}

	if (env.GITLAB_URL && env.GITLAB_PROJECT_ID) {
		const baseUrl = env.GITLAB_URL;
		const clientId = env.GITLAB_CLIENT_ID;
		const getToken = createTokenProvider({
			store: createGitLabTokenStore(credentialPaths.gitlabToken),
			// Without a client ID (never logged in via the delegated flow yet, static-PAT-only
			// setups) there is nothing to refresh against — omit rather than fail every call.
			refresh: clientId ? (current) => refreshGitLabToken({ baseUrl, clientId }, current.refreshToken as string) : undefined,
			staticFallback: () => resolveStaticGitLabToken(env),
			enigmaSource: () => tryEnigma("gitlab", { env }),
		});
		adapters.push(createGitLabAdapter({ name: "gitlab", baseUrl, projectId: env.GITLAB_PROJECT_ID, getToken }));
	} else {
		unconfigured.push({ name: "gitlab", type: "gitlab" });
	}

	const jenkinsCredentials = await resolveJenkinsCredentials(createFileCredentialStore(credentialPaths.jenkinsCredentials), env);
	if (jenkinsCredentials) {
		adapters.push(createJenkinsAdapter({ name: "jenkins", credentials: jenkinsCredentials }));
	} else {
		unconfigured.push({ name: "jenkins", type: "jenkins" });
	}

	return { adapters, unconfigured };
}

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
import { profiledBackend, type PipesCredentialPaths } from "../paths.ts";
import type { GitLabRepoTarget, RepoConfigFile } from "../repo-config.ts";
import { tryEnigmaAccessToken } from "@danypops/enigma-client";
import { createGitHubTokenStore, resolveStaticToken as resolveStaticGitHubToken } from "./github/auth.ts";
import { createGitHubAdapter } from "./github/github-adapter.ts";
import { createGitLabTokenStore, refreshAccessToken as refreshGitLabToken, resolveStaticToken as resolveStaticGitLabToken } from "./gitlab/auth.ts";
import { createGitLabAdapter } from "./gitlab/gitlab-adapter.ts";
import { createFileCredentialStore, resolveJenkinsCredentials, resolveJenkinsCredentialsForBaseUrl } from "./jenkins/auth.ts";
import { createJenkinsAdapter } from "./jenkins/jenkins-adapter.ts";
import { createTokenProvider } from "./token-provider.ts";

export interface ConfiguredBackends {
	adapters: CIBackend[];
	unconfigured: BackendInfo[];
}

const NO_REPO_TARGETS: RepoConfigFile = { github: [], gitlab: [], jenkins: [] };

export async function buildConfiguredAdapters(
	credentialPaths: PipesCredentialPaths,
	env: Record<string, string | undefined> = process.env,
	tryEnigma: typeof tryEnigmaAccessToken = tryEnigmaAccessToken,
	repoConfig: RepoConfigFile = NO_REPO_TARGETS,
): Promise<ConfiguredBackends> {
	const adapters: CIBackend[] = [];
	const unconfigured: BackendInfo[] = [];
	const dir = credentialPaths.credentialsDir;

	// Login (device flow / PKCE) writes to these same store files; a token provider
	// re-reads on every call, so a freshly logged-in or refreshed credential is picked
	// up by an already-running daemon without needing a restart or adapter rebuild.
	//
	// Explicit repos.json targets take priority over the single GITHUB_OWNER/GITHUB_REPO
	// pair so a repo-registry file, once created, is the one source of truth rather than
	// silently merging with leftover env vars from an older single-repo setup.
	const githubTargets =
		repoConfig.github.length > 0
			? repoConfig.github
			: env.GITHUB_OWNER && env.GITHUB_REPO
				? [{ name: "github", owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO }]
				: [];

	if (githubTargets.length > 0) {
		for (const target of githubTargets) {
			// GitHub OAuth Apps' device flow never issues a refresh token (confirmed against
			// GitHub's own docs: the device-flow token response has no refresh_token field,
			// and refresh is a GitHub-App-only feature) — no refresh function to pass. Targets
			// that share a profile (or all omit one) share the same underlying file: one token
			// authenticates every repo the granting user can access, so there's no need for
			// separate logins unless a target explicitly opts into its own profile.
			const getToken = createTokenProvider({
				store: createGitHubTokenStore(dir, profiledBackend("github", target.profile)),
				staticFallback: () => resolveStaticGitHubToken(env),
				// ENIGMA_CLIENT_TOKEN is this daemon's own registered-client token (`enigma client
				// add pipes --backends ...`), scoped to exactly the backends pipes needs -- preferred
				// over Enigma's shared admin-token file, which grants every vaulted backend. Asks
				// Enigma for the same profile-qualified name (e.g. "github-work") this target's local
				// store uses -- an Enigma alias and a pipes profile share one naming convention on
				// purpose, so moving a profile from the local store to Enigma is a rename, not a
				// re-architecture.
				enigmaSource: () => tryEnigma(profiledBackend("github", target.profile), { env, token: env.ENIGMA_CLIENT_TOKEN }),
			});
			adapters.push(createGitHubAdapter({ name: target.name, owner: target.owner, repo: target.repo, getToken }));
		}
	} else {
		unconfigured.push({ name: "github", type: "github" });
	}

	const gitlabTargets: (GitLabRepoTarget & { baseUrl: string })[] =
		repoConfig.gitlab.length > 0
			? repoConfig.gitlab.map((target) => ({ ...target, baseUrl: target.baseUrl ?? env.GITLAB_URL ?? "" })).filter((target) => target.baseUrl !== "")
			: env.GITLAB_URL && env.GITLAB_PROJECT_ID
				? [{ name: "gitlab", projectId: env.GITLAB_PROJECT_ID, baseUrl: env.GITLAB_URL }]
				: [];

	if (gitlabTargets.length > 0) {
		// A GitLab token authenticates every project on the host it was issued for (not just
		// one project), so targets sharing a host and profile share one token provider; a
		// target naming a different host still resolves against the one configured
		// credential store/env, which is only correct when every configured target is on the
		// same GitLab instance — multi-host GitLab is not yet supported.
		for (const target of gitlabTargets) {
			const baseUrl = target.baseUrl;
			const clientId = target.clientId ?? env.GITLAB_CLIENT_ID;
			const getToken = createTokenProvider({
				store: createGitLabTokenStore(dir, profiledBackend("gitlab", target.profile)),
				// Without a client ID (never logged in via the delegated flow yet, static-PAT-only
				// setups) there is nothing to refresh against — omit rather than fail every call.
				refresh: clientId ? (current) => refreshGitLabToken({ baseUrl, clientId }, current.refreshToken as string) : undefined,
				staticFallback: () => resolveStaticGitLabToken(env),
				// Same profile-qualified naming as the GitHub target above -- an Enigma alias and a
				// pipes profile are the same name on purpose.
				enigmaSource: () => tryEnigma(profiledBackend("gitlab", target.profile), { env, token: env.ENIGMA_CLIENT_TOKEN }),
			});
			adapters.push(createGitLabAdapter({ name: target.name, baseUrl, projectId: target.projectId, getToken }));
		}
	} else {
		unconfigured.push({ name: "gitlab", type: "gitlab" });
	}

	if (repoConfig.jenkins.length > 0) {
		// Multiple named Jenkins servers -- env.JENKINS_URL is the single-instance legacy
		// default's own signal and is not consulted per-target here, since one ambient env
		// triple can't stand in for N different servers.
		for (const target of repoConfig.jenkins) {
			// A Jenkins target's default profile is its own full name, not a suffix on a shared
			// "jenkins" identity the way github/gitlab profiles are -- each server is naturally
			// its own self-contained credential unless a target explicitly opts into sharing one
			// (two target names both set the same `profile` to point at the same stored file).
			const profile = target.profile ?? target.name;
			const credentials = await resolveJenkinsCredentialsForBaseUrl(createFileCredentialStore(dir, profile), target.baseUrl, profile, env);
			if (credentials) {
				adapters.push(createJenkinsAdapter({ name: target.name, credentials }));
			} else {
				unconfigured.push({ name: target.name, type: "jenkins" });
			}
		}
	} else {
		const jenkinsCredentials = await resolveJenkinsCredentials(createFileCredentialStore(dir, "jenkins"), env);
		if (jenkinsCredentials) {
			adapters.push(createJenkinsAdapter({ name: "jenkins", credentials: jenkinsCredentials }));
		} else {
			unconfigured.push({ name: "jenkins", type: "jenkins" });
		}
	}

	return { adapters, unconfigured };
}

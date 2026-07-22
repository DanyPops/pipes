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
import { createFileTokenStore as createGitHubTokenStore, resolveGitHubToken } from "./github/auth.ts";
import { createGitHubAdapter } from "./github/github-adapter.ts";
import { createFileTokenStore as createGitLabTokenStore, resolveGitLabToken } from "./gitlab/auth.ts";
import { createGitLabAdapter } from "./gitlab/gitlab-adapter.ts";
import { createFileCredentialStore, resolveJenkinsCredentials } from "./jenkins/auth.ts";
import { createJenkinsAdapter } from "./jenkins/jenkins-adapter.ts";

export interface ConfiguredBackends {
	adapters: CIBackend[];
	unconfigured: BackendInfo[];
}

export function buildConfiguredAdapters(
	credentialPaths: PipesCredentialPaths,
	env: Record<string, string | undefined> = process.env,
): ConfiguredBackends {
	const adapters: CIBackend[] = [];
	const unconfigured: BackendInfo[] = [];

	if (env.GITHUB_OWNER && env.GITHUB_REPO) {
		const token = resolveGitHubToken(createGitHubTokenStore(credentialPaths.githubToken), env);
		adapters.push(createGitHubAdapter({ name: "github", owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO, token }));
	} else {
		unconfigured.push({ name: "github", type: "github" });
	}

	if (env.GITLAB_URL && env.GITLAB_PROJECT_ID) {
		const token = resolveGitLabToken(createGitLabTokenStore(credentialPaths.gitlabToken), env);
		adapters.push(createGitLabAdapter({ name: "gitlab", baseUrl: env.GITLAB_URL, projectId: env.GITLAB_PROJECT_ID, token }));
	} else {
		unconfigured.push({ name: "gitlab", type: "gitlab" });
	}

	const jenkinsCredentials = resolveJenkinsCredentials(createFileCredentialStore(credentialPaths.jenkinsCredentials), env);
	if (jenkinsCredentials) {
		adapters.push(createJenkinsAdapter({ name: "jenkins", credentials: jenkinsCredentials }));
	} else {
		unconfigured.push({ name: "jenkins", type: "jenkins" });
	}

	return { adapters, unconfigured };
}

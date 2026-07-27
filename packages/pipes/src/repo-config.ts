/**
 * Loads named per-repo/per-project targets for the GitHub and GitLab
 * backends — the agent never authors or sees this file, only the
 * resulting backend names (same convention as presets.ts's pipelines.json).
 * Lets a single daemon address multiple repos/projects of the same backend
 * type instead of the one hardcoded owner/repo (or projectId) a bare
 * GITHUB_OWNER/GITHUB_REPO (or GITLAB_URL/GITLAB_PROJECT_ID) env pair allows.
 *
 * Credentials stay backend-type-scoped, not per-target: a GitHub device-flow
 * token authenticates any repo the granting user can access, and a GitLab
 * token authenticates any project on the host it was issued for — so every
 * target here shares the one already-configured credential store, it just
 * points requests at a different owner/repo or projectId.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface GitHubRepoTarget {
	name: string;
	owner: string;
	repo: string;
}

export interface GitLabRepoTarget {
	name: string;
	projectId: string;
	/** Defaults to GITLAB_URL when omitted — every target normally shares one GitLab host. */
	baseUrl?: string;
	/** Defaults to GITLAB_CLIENT_ID when omitted. */
	clientId?: string;
}

export interface RepoConfigFile {
	github: GitHubRepoTarget[];
	gitlab: GitLabRepoTarget[];
}

export function defaultRepoConfigPath(env: Record<string, string | undefined> = process.env, home = homedir()): string {
	const configHome = env.XDG_CONFIG_HOME ?? join(home, ".config");
	return join(configHome, "pipes", "repos.json");
}

/** Returns {github: [], gitlab: []} when the file doesn't exist yet — multi-repo config is optional, not required to boot. */
export function loadRepoConfig(path: string): RepoConfigFile {
	if (!existsSync(path)) return { github: [], gitlab: [] };
	const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RepoConfigFile>;
	const github = parsed.github ?? [];
	const gitlab = parsed.gitlab ?? [];
	if (!Array.isArray(github) || !Array.isArray(gitlab)) {
		throw new Error(`${path}: expected "github" and "gitlab" to each be arrays`);
	}
	return { github, gitlab };
}

/** Persists the full target set back to the same human-edited file loadRepoConfig reads, atomically (write-then-rename). */
export function saveRepoConfig(path: string, config: RepoConfigFile): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(config, null, "\t")}\n`, { mode: 0o600 });
	renameSync(temporary, path);
}

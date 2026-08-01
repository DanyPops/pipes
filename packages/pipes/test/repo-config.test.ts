import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRepoConfigPath, loadRepoConfig, saveRepoConfig } from "../src/repo-config.ts";

let dir: string | undefined;

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

describe("defaultRepoConfigPath", () => {
	it("resolves under XDG_CONFIG_HOME/pipes/repos.json", () => {
		const path = defaultRepoConfigPath({ XDG_CONFIG_HOME: "/config" }, "/home/x");
		expect(path).toBe("/config/pipes/repos.json");
	});

	it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
		const path = defaultRepoConfigPath({}, "/home/x");
		expect(path).toBe("/home/x/.config/pipes/repos.json");
	});
});

describe("loadRepoConfig", () => {
	it("returns empty github/gitlab/jenkins arrays when the file doesn't exist -- multi-repo config is optional", () => {
		dir = mkdtempSync(join(tmpdir(), "pipes-repos-"));
		expect(loadRepoConfig(join(dir, "missing.json"))).toEqual({ github: [], gitlab: [], jenkins: [] });
	});

	it("defaults a missing github, gitlab, or jenkins key to an empty array rather than requiring all three", () => {
		dir = mkdtempSync(join(tmpdir(), "pipes-repos-"));
		const path = join(dir, "repos.json");
		Bun.write(path, JSON.stringify({ github: [{ name: "github-a", owner: "octocat", repo: "repo-a" }] }));
		expect(loadRepoConfig(path)).toEqual({ github: [{ name: "github-a", owner: "octocat", repo: "repo-a" }], gitlab: [], jenkins: [] });
	});

	it("loads jenkins targets with an optional profile field", () => {
		dir = mkdtempSync(join(tmpdir(), "pipes-repos-"));
		const path = join(dir, "repos.json");
		const jenkins = [
			{ name: "jenkins-a", baseUrl: "https://jenkins-a.example.com" },
			{ name: "jenkins-b", baseUrl: "https://jenkins-b.example.com", profile: "shared" },
		];
		Bun.write(path, JSON.stringify({ jenkins }));
		expect(loadRepoConfig(path)).toEqual({ github: [], gitlab: [], jenkins });
	});

	it("throws when github, gitlab, or jenkins is present but not an array", () => {
		dir = mkdtempSync(join(tmpdir(), "pipes-repos-"));
		const path = join(dir, "repos.json");
		Bun.write(path, JSON.stringify({ github: { name: "not-an-array" } }));
		expect(() => loadRepoConfig(path)).toThrow(/expected "github", "gitlab", and "jenkins" to each be arrays/);
	});
});

describe("saveRepoConfig / loadRepoConfig round-trip", () => {
	it("persists and reloads the exact same target set, including jenkins and profile fields", () => {
		dir = mkdtempSync(join(tmpdir(), "pipes-repos-"));
		const path = join(dir, "nested", "repos.json");
		const config = {
			github: [
				{ name: "github-a", owner: "octocat", repo: "repo-a" },
				{ name: "github-work", owner: "AcmeCorp", repo: "internal", profile: "work" },
			],
			gitlab: [{ name: "gitlab-a", projectId: "42" }],
			jenkins: [
				{ name: "jenkins-a", baseUrl: "https://jenkins-a.example.com" },
				{ name: "jenkins-b", baseUrl: "https://jenkins-b.example.com" },
			],
		};

		saveRepoConfig(path, config);

		expect(loadRepoConfig(path)).toEqual(config);
	});

	it("creates parent directories that don't exist yet", () => {
		dir = mkdtempSync(join(tmpdir(), "pipes-repos-"));
		const path = join(dir, "a", "b", "c", "repos.json");
		saveRepoConfig(path, { github: [], gitlab: [], jenkins: [] });
		expect(loadRepoConfig(path)).toEqual({ github: [], gitlab: [], jenkins: [] });
	});

	it("writes the file with restrictive permissions, never leaving world/group-readable repo config", () => {
		dir = mkdtempSync(join(tmpdir(), "pipes-repos-"));
		const path = join(dir, "repos.json");
		saveRepoConfig(path, { github: [{ name: "github-a", owner: "octocat", repo: "repo-a" }], gitlab: [], jenkins: [] });

		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("leaves no temp file behind after a successful save", () => {
		dir = mkdtempSync(join(tmpdir(), "pipes-repos-"));
		const path = join(dir, "repos.json");
		saveRepoConfig(path, { github: [], gitlab: [], jenkins: [] });

		const remaining = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
		expect(remaining).toEqual([]);
	});
});

import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
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
	it("returns empty github/gitlab arrays when the file doesn't exist -- multi-repo config is optional", () => {
		dir = mkdtempSync(join(tmpdir(), "pipes-repos-"));
		expect(loadRepoConfig(join(dir, "missing.json"))).toEqual({ github: [], gitlab: [] });
	});

	it("defaults a missing github or gitlab key to an empty array rather than requiring both", () => {
		dir = mkdtempSync(join(tmpdir(), "pipes-repos-"));
		const path = join(dir, "repos.json");
		Bun.write(path, JSON.stringify({ github: [{ name: "github-lector", owner: "DanyPops", repo: "lector" }] }));
		expect(loadRepoConfig(path)).toEqual({ github: [{ name: "github-lector", owner: "DanyPops", repo: "lector" }], gitlab: [] });
	});

	it("throws when github or gitlab is present but not an array", () => {
		dir = mkdtempSync(join(tmpdir(), "pipes-repos-"));
		const path = join(dir, "repos.json");
		Bun.write(path, JSON.stringify({ github: { name: "not-an-array" } }));
		expect(() => loadRepoConfig(path)).toThrow(/expected "github" and "gitlab" to each be arrays/);
	});
});

describe("saveRepoConfig / loadRepoConfig round-trip", () => {
	it("persists and reloads the exact same target set", () => {
		dir = mkdtempSync(join(tmpdir(), "pipes-repos-"));
		const path = join(dir, "nested", "repos.json");
		const config = {
			github: [
				{ name: "github-lector", owner: "DanyPops", repo: "lector" },
				{ name: "github-packed", owner: "DanyPops", repo: "pi-packed" },
			],
			gitlab: [{ name: "gitlab-infra", projectId: "42" }],
		};

		saveRepoConfig(path, config);

		expect(loadRepoConfig(path)).toEqual(config);
	});

	it("creates parent directories that don't exist yet", () => {
		dir = mkdtempSync(join(tmpdir(), "pipes-repos-"));
		const path = join(dir, "a", "b", "c", "repos.json");
		saveRepoConfig(path, { github: [], gitlab: [] });
		expect(loadRepoConfig(path)).toEqual({ github: [], gitlab: [] });
	});

	it("writes the file with restrictive permissions, never leaving world/group-readable repo config", () => {
		dir = mkdtempSync(join(tmpdir(), "pipes-repos-"));
		const path = join(dir, "repos.json");
		saveRepoConfig(path, { github: [{ name: "github-lector", owner: "DanyPops", repo: "lector" }], gitlab: [] });

		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("leaves no temp file behind after a successful save", () => {
		dir = mkdtempSync(join(tmpdir(), "pipes-repos-"));
		const path = join(dir, "repos.json");
		saveRepoConfig(path, { github: [], gitlab: [] });

		const remaining = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
		expect(remaining).toEqual([]);
	});
});

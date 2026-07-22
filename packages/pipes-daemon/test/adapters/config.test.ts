import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfiguredAdapters } from "../../src/adapters/config.ts";

function credentialPaths(dir: string) {
	return {
		githubToken: join(dir, "github-token.json"),
		gitlabToken: join(dir, "gitlab-token.json"),
		jenkinsCredentials: join(dir, "jenkins-credentials.json"),
	};
}

describe("buildConfiguredAdapters", () => {
	it("configures zero adapters and reports all three as unconfigured when no env is set", () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
		try {
			const { adapters, unconfigured } = buildConfiguredAdapters(credentialPaths(dir), {});
			expect(adapters).toHaveLength(0);
			expect(unconfigured.map((b) => b.name).sort()).toEqual(["github", "gitlab", "jenkins"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("configures only the backends with sufficient env vars present, leaving the rest unconfigured", () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
		try {
			const { adapters, unconfigured } = buildConfiguredAdapters(credentialPaths(dir), {
				GITHUB_OWNER: "openshift",
				GITHUB_REPO: "pipes",
				GITHUB_TOKEN: "gh-token",
			});
			expect(adapters).toHaveLength(1);
			expect(adapters[0]?.name()).toBe("github");
			expect(adapters[0]?.type()).toBe("github");
			expect(unconfigured.map((b) => b.name).sort()).toEqual(["gitlab", "jenkins"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("configures all three when every backend has sufficient env vars", () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
		try {
			const { adapters, unconfigured } = buildConfiguredAdapters(credentialPaths(dir), {
				GITHUB_OWNER: "openshift",
				GITHUB_REPO: "pipes",
				GITHUB_TOKEN: "gh-token",
				GITLAB_URL: "https://gitlab.example.com",
				GITLAB_PROJECT_ID: "42",
				GITLAB_TOKEN: "gl-token",
				JENKINS_URL: "https://jenkins.example.com",
				JENKINS_USER: "bot",
				JENKINS_API_TOKEN: "jk-token",
			});
			expect(adapters.map((a) => a.name()).sort()).toEqual(["github", "gitlab", "jenkins"]);
			expect(unconfigured).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never performs network I/O while resolving configuration (adapters do none at construction)", () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
		try {
			expect(() =>
				buildConfiguredAdapters(credentialPaths(dir), {
					GITHUB_OWNER: "openshift",
					GITHUB_REPO: "pipes",
					GITLAB_URL: "https://gitlab.example.com",
					GITLAB_PROJECT_ID: "42",
					JENKINS_URL: "https://jenkins.example.com",
					JENKINS_USER: "bot",
					JENKINS_API_TOKEN: "jk-token",
				}),
			).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

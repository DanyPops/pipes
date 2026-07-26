import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfiguredAdapters } from "../../src/adapters/config.ts";
import type { TryEnigmaCredential } from "../../src/adapters/enigma-source.ts";

function credentialPaths(dir: string) {
	return {
		githubToken: join(dir, "github-token.json"),
		gitlabToken: join(dir, "gitlab-token.json"),
		jenkinsCredentials: join(dir, "jenkins-credentials.json"),
	};
}

/**
 * Never the real tryEnigmaCredential in a test: it does a real filesystem
 * check against $XDG_RUNTIME_DIR, and a real Enigma daemon may genuinely be
 * running on the machine executing this suite -- tests must never depend on
 * ambient host state. `noEnigma` is the isolated default for every test not
 * specifically exercising Enigma-first behavior.
 */
const noEnigma: TryEnigmaCredential = async () => undefined;

describe("buildConfiguredAdapters", () => {
	it("configures zero adapters and reports all three as unconfigured when no env is set", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
		try {
			const { adapters, unconfigured } = await buildConfiguredAdapters(credentialPaths(dir), {}, noEnigma);
			expect(adapters).toHaveLength(0);
			expect(unconfigured.map((b) => b.name).sort()).toEqual(["github", "gitlab", "jenkins"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("configures only the backends with sufficient env vars present, leaving the rest unconfigured", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
		try {
			const { adapters, unconfigured } = await buildConfiguredAdapters(
				credentialPaths(dir),
				{
					GITHUB_OWNER: "openshift",
					GITHUB_REPO: "pipes",
					GITHUB_TOKEN: "gh-token",
				},
				noEnigma,
			);
			expect(adapters).toHaveLength(1);
			expect(adapters[0]?.name()).toBe("github");
			expect(adapters[0]?.type()).toBe("github");
			expect(unconfigured.map((b) => b.name).sort()).toEqual(["gitlab", "jenkins"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("configures all three when every backend has sufficient env vars", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
		try {
			const { adapters, unconfigured } = await buildConfiguredAdapters(
				credentialPaths(dir),
				{
					GITHUB_OWNER: "openshift",
					GITHUB_REPO: "pipes",
					GITHUB_TOKEN: "gh-token",
					GITLAB_URL: "https://gitlab.example.com",
					GITLAB_PROJECT_ID: "42",
					GITLAB_TOKEN: "gl-token",
					JENKINS_URL: "https://jenkins.example.com",
					JENKINS_USER: "bot",
					JENKINS_API_TOKEN: "jk-token",
				},
				noEnigma,
			);
			expect(adapters.map((a) => a.name()).sort()).toEqual(["github", "gitlab", "jenkins"]);
			expect(unconfigured).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never performs network I/O while resolving configuration (adapters do none at construction)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
		try {
			// If this rejected, the await below would throw and bun:test would fail the case --
			// no explicit .resolves/.rejects matcher needed for a plain "must not throw" assertion.
			const { adapters } = await buildConfiguredAdapters(
				credentialPaths(dir),
				{
					GITHUB_OWNER: "openshift",
					GITHUB_REPO: "pipes",
					GITLAB_URL: "https://gitlab.example.com",
					GITLAB_PROJECT_ID: "42",
					JENKINS_URL: "https://jenkins.example.com",
					JENKINS_USER: "bot",
					JENKINS_API_TOKEN: "jk-token",
				},
				noEnigma,
			);
			expect(adapters.length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("buildConfiguredAdapters > Enigma as an optional, additive credential source", () => {
	it("passes github/gitlab through to createTokenProvider's enigmaSource, and Enigma's token wins over a static PAT on the adapter's own next getToken() call", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
		try {
			const calls: string[] = [];
			const fromEnigma: TryEnigmaCredential = async (backend) => {
				calls.push(backend);
				return backend === "github" ? "enigma-supplied-github-token" : undefined;
			};
			const { adapters } = await buildConfiguredAdapters(
				credentialPaths(dir),
				{ GITHUB_OWNER: "openshift", GITHUB_REPO: "pipes", GITHUB_TOKEN: "static-config-token-should-lose" },
				fromEnigma,
			);
			expect(adapters).toHaveLength(1);
			// enigmaSource is only actually invoked on getToken() (per-request), not at construction --
			// confirmed by the preceding "never performs network I/O ... at construction" test above.
			expect(calls).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("still configures every backend when Enigma has nothing for any of them, unchanged from before Enigma existed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
		try {
			const { adapters } = await buildConfiguredAdapters(
				credentialPaths(dir),
				{
					GITHUB_OWNER: "openshift",
					GITHUB_REPO: "pipes",
					GITHUB_TOKEN: "gh-token",
					GITLAB_URL: "https://gitlab.example.com",
					GITLAB_PROJECT_ID: "42",
					GITLAB_TOKEN: "gl-token",
					JENKINS_URL: "https://jenkins.example.com",
					JENKINS_USER: "bot",
					JENKINS_API_TOKEN: "jk-token",
				},
				noEnigma,
			);
			expect(adapters.map((a) => a.name()).sort()).toEqual(["github", "gitlab", "jenkins"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

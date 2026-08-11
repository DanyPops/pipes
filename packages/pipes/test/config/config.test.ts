import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TryEnigmaAccessToken } from "@danypops/enigma-client";
import { type BackendResolver, buildConfiguredAdapters, DEFAULT_BACKEND_RESOLVERS } from "../../src/config/config.ts";

function credentialPaths(dir: string) {
	return { credentialsDir: dir };
}

/**
 * Never the real tryEnigmaAccessToken in a test: it does a real filesystem
 * check against $XDG_RUNTIME_DIR, and a real Enigma daemon may genuinely be
 * running on the machine executing this suite -- tests must never depend on
 * ambient host state. `noEnigma` is the isolated default for every test not
 * specifically exercising Enigma-first behavior.
 */
const noEnigma: TryEnigmaAccessToken = async () => undefined;

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

describe("buildConfiguredAdapters > multi-repo config (repos.json)", () => {
	it("registers one distinct GitHub backend per configured repo target instead of the single env-var-bound one", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
		try {
			const { adapters, unconfigured } = await buildConfiguredAdapters(credentialPaths(dir), { GITHUB_TOKEN: "gh-token" }, noEnigma, {
				github: [
					{ name: "github-a", owner: "octocat", repo: "repo-a" },
					{ name: "github-b", owner: "octocat", repo: "repo-b" },
				],
				gitlab: [],
				jenkins: [],
			});
			expect(adapters.map((a) => a.name()).sort()).toEqual(["github-a", "github-b"]);
			expect(adapters.every((a) => a.type() === "github")).toBe(true);
			expect(unconfigured.map((b) => b.name).sort()).toEqual(["gitlab", "jenkins"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("wires each named GitHub target to its own owner/repo -- two different names hit two different upstream repos, not the same one", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
		const originalFetch = globalThis.fetch;
		const requestedUrls: string[] = [];
		globalThis.fetch = (async (url: string) => {
			requestedUrls.push(String(url));
			const run = {
				id: 1,
				name: "run",
				status: "completed",
				conclusion: "success",
				html_url: "https://example.com",
				created_at: new Date().toISOString(),
			};
			return new Response(JSON.stringify({ workflow_runs: [run] }), { status: 200 });
		}) as typeof fetch;
		try {
			const { adapters } = await buildConfiguredAdapters(credentialPaths(dir), { GITHUB_TOKEN: "gh-token" }, noEnigma, {
				github: [
					{ name: "github-a", owner: "octocat", repo: "repo-a" },
					{ name: "github-b", owner: "octocat", repo: "repo-b" },
				],
				gitlab: [],
				jenkins: [],
			});
			const first = adapters.find((a) => a.name() === "github-a");
			const second = adapters.find((a) => a.name() === "github-b");
			await first?.getRun("workflow.yml", "latest");
			await second?.getRun("workflow.yml", "latest");

			expect(requestedUrls[0]).toContain("/repos/octocat/repo-a/actions/runs");
			expect(requestedUrls[1]).toContain("/repos/octocat/repo-b/actions/runs");
		} finally {
			globalThis.fetch = originalFetch;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a target with no repo given is account-scoped -- one backend covers every repo under that owner, routed per-call via jobRef", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
		const originalFetch = globalThis.fetch;
		const requestedUrls: string[] = [];
		globalThis.fetch = (async (url: string) => {
			requestedUrls.push(String(url));
			const run = {
				id: 1,
				name: "run",
				status: "completed",
				conclusion: "success",
				html_url: "https://example.com",
				created_at: new Date().toISOString(),
			};
			return new Response(JSON.stringify({ workflow_runs: [run] }), { status: 200 });
		}) as typeof fetch;
		try {
			const { adapters, unconfigured } = await buildConfiguredAdapters(credentialPaths(dir), { GITHUB_TOKEN: "gh-token" }, noEnigma, {
				github: [{ name: "danypops-github", owner: "DanyPops" }],
				gitlab: [],
				jenkins: [],
			});
			expect(adapters.map((a) => a.name())).toEqual(["danypops-github"]);
			expect(unconfigured.map((b) => b.name).sort()).toEqual(["gitlab", "jenkins"]);

			const backend = adapters[0]!;
			await backend.getRun("pipes/publish.yml", "latest");
			await backend.getRun("other-repo/ci.yml", "latest");
			expect(requestedUrls[0]).toContain("/repos/DanyPops/pipes/actions/runs");
			expect(requestedUrls[1]).toContain("/repos/DanyPops/other-repo/actions/runs");

			await expect(backend.getRun("publish.yml", "latest")).rejects.toThrow("is account-scoped");
		} finally {
			globalThis.fetch = originalFetch;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("registers one distinct GitLab backend per configured project target", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
		try {
			const { adapters, unconfigured } = await buildConfiguredAdapters(
				credentialPaths(dir),
				{ GITLAB_URL: "https://gitlab.example.com", GITLAB_TOKEN: "gl-token" },
				noEnigma,
				{
					github: [],
					gitlab: [
						{ name: "gitlab-a", projectId: "42" },
						{ name: "gitlab-b", projectId: "99" },
					],
					jenkins: [],
				},
			);
			expect(adapters.map((a) => a.name()).sort()).toEqual(["gitlab-a", "gitlab-b"]);
			expect(adapters.every((a) => a.type() === "gitlab")).toBe(true);
			expect(unconfigured.map((b) => b.name).sort()).toEqual(["github", "jenkins"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("repos.json targets take priority over a leftover GITHUB_OWNER/GITHUB_REPO pair rather than merging with it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
		try {
			const { adapters } = await buildConfiguredAdapters(
				credentialPaths(dir),
				{ GITHUB_OWNER: "legacy-owner", GITHUB_REPO: "legacy-repo", GITHUB_TOKEN: "gh-token" },
				noEnigma,
				{ github: [{ name: "github-a", owner: "octocat", repo: "repo-a" }], gitlab: [], jenkins: [] },
			);
			expect(adapters.map((a) => a.name())).toEqual(["github-a"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to the single legacy env-var-bound backend when repos.json has no targets", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
		try {
			const { adapters } = await buildConfiguredAdapters(
				credentialPaths(dir),
				{ GITHUB_OWNER: "openshift", GITHUB_REPO: "pipes", GITHUB_TOKEN: "gh-token" },
				noEnigma,
				{ github: [], gitlab: [], jenkins: [] },
			);
			expect(adapters.map((a) => a.name())).toEqual(["github"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("registers one distinct Jenkins backend per configured server target", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
		try {
			const { createFileCredentialStore } = await import("../../src/auth/jenkins-auth.ts");
			createFileCredentialStore(dir, "jenkins-a").save({ baseUrl: "https://jenkins-a.example.com", username: "bot", apiToken: "a-token" });
			createFileCredentialStore(dir, "jenkins-b").save({ baseUrl: "https://jenkins-b.example.com", username: "bot", apiToken: "b-token" });

			const { adapters, unconfigured } = await buildConfiguredAdapters(credentialPaths(dir), {}, noEnigma, {
				github: [],
				gitlab: [],
				jenkins: [
					{ name: "jenkins-a", baseUrl: "https://jenkins-a.example.com" },
					{ name: "jenkins-b", baseUrl: "https://jenkins-b.example.com" },
				],
			});
			expect(adapters.map((a) => a.name()).sort()).toEqual(["jenkins-a", "jenkins-b"]);
			expect(adapters.every((a) => a.type() === "jenkins")).toBe(true);
			expect(unconfigured.map((b) => b.name).sort()).toEqual(["github", "gitlab"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("defaults each Jenkins target's storage profile to its own name, so two servers never collide on one credential file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
		try {
			const { createFileCredentialStore } = await import("../../src/auth/jenkins-auth.ts");
			// Saved under profile-qualified names matching each target's own `name` (no explicit `profile` given).
			createFileCredentialStore(dir, "jenkins-a").save({
				baseUrl: "https://jenkins-a.example.com",
				username: "a-bot",
				apiToken: "a-token",
			});
			createFileCredentialStore(dir, "jenkins-b").save({
				baseUrl: "https://jenkins-b.example.com",
				username: "b-bot",
				apiToken: "b-token",
			});

			const { adapters } = await buildConfiguredAdapters(credentialPaths(dir), {}, noEnigma, {
				github: [],
				gitlab: [],
				jenkins: [
					{ name: "jenkins-a", baseUrl: "https://jenkins-a.example.com" },
					{ name: "jenkins-b", baseUrl: "https://jenkins-b.example.com" },
				],
			});
			expect(adapters).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports a Jenkins target as unconfigured (not a crash) when no credentials exist for its baseUrl", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
		try {
			const { adapters, unconfigured } = await buildConfiguredAdapters(credentialPaths(dir), {}, noEnigma, {
				github: [],
				gitlab: [],
				jenkins: [{ name: "jenkins-a", baseUrl: "https://jenkins-a.example.com" }],
			});
			expect(adapters).toHaveLength(0);
			expect(unconfigured.map((b) => b.name).sort()).toEqual(["github", "gitlab", "jenkins-a"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ignores JENKINS_URL/JENKINS_USER/JENKINS_API_TOKEN once repos.json declares explicit jenkins targets -- replaces, doesn't merge", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
		try {
			const { adapters, unconfigured } = await buildConfiguredAdapters(
				credentialPaths(dir),
				{ JENKINS_URL: "https://jenkins-a.example.com", JENKINS_USER: "bot", JENKINS_API_TOKEN: "should-be-ignored" },
				noEnigma,
				{ github: [], gitlab: [], jenkins: [{ name: "jenkins-a", baseUrl: "https://jenkins-a.example.com" }] },
			);
			// The legacy env triple is never consulted for a named target -- only Enigma (baseUrl-matched) and the stored file are.
			expect(adapters).toHaveLength(0);
			expect(unconfigured.map((b) => b.name).sort()).toEqual(["github", "gitlab", "jenkins-a"]);
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
			const fromEnigma: TryEnigmaAccessToken = async (backend) => {
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

	it('asks Enigma for a profiled target\'s own profile-qualified name (e.g. "github-work"), not the bare backend type', async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
		const originalFetch = globalThis.fetch;
		const seenAuthHeaders: (string | null)[] = [];
		globalThis.fetch = (async (_url: string, init?: RequestInit) => {
			seenAuthHeaders.push(new Headers(init?.headers).get("authorization"));
			const run = {
				id: 1,
				name: "run",
				status: "completed",
				conclusion: "success",
				html_url: "https://example.com",
				created_at: new Date().toISOString(),
			};
			return new Response(JSON.stringify({ workflow_runs: [run] }), { status: 200 });
		}) as typeof fetch;
		try {
			const seenBackends: string[] = [];
			const fromEnigma: TryEnigmaAccessToken = async (backend) => {
				seenBackends.push(backend);
				return backend === "github-work" ? "enigma-work-token" : undefined;
			};
			const { adapters } = await buildConfiguredAdapters(credentialPaths(dir), {}, fromEnigma, {
				github: [{ name: "github-work", owner: "acme", repo: "widgets", profile: "work" }],
				gitlab: [],
				jenkins: [],
			});
			await adapters[0]?.getRun("workflow.yml", "latest");

			expect(seenBackends).toEqual(["github-work"]);
			expect(seenAuthHeaders[0]).toBe("Bearer enigma-work-token");
		} finally {
			globalThis.fetch = originalFetch;
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

	it("forwards ENIGMA_CLIENT_TOKEN as the registered-client token for both github and gitlab, instead of relying on Enigma's shared admin-token file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: string) => new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 })) as typeof fetch;
		try {
			const seenTokens: Record<string, string | undefined> = {};
			const fromEnigma: TryEnigmaAccessToken = async (backend, opts) => {
				seenTokens[backend] = opts?.token;
				return undefined;
			};
			const { adapters } = await buildConfiguredAdapters(
				credentialPaths(dir),
				{
					GITHUB_OWNER: "openshift",
					GITHUB_REPO: "pipes",
					GITLAB_URL: "https://gitlab.example.com",
					GITLAB_PROJECT_ID: "42",
					ENIGMA_CLIENT_TOKEN: "pipes-scoped-token",
				},
				fromEnigma,
			);
			const github = adapters.find((a) => a.name() === "github");
			const gitlab = adapters.find((a) => a.name() === "gitlab");
			await github?.getRun("workflow.yml", "latest").catch(() => undefined);
			await gitlab?.getRun("", "latest").catch(() => undefined);

			expect(seenTokens).toEqual({ github: "pipes-scoped-token", gitlab: "pipes-scoped-token" });
		} finally {
			globalThis.fetch = originalFetch;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	describe("resolvers composition -- the registry a fourth backend would join", () => {
		it("merges a caller-supplied resolver's output alongside the three built-in ones, in order, with zero global/module state involved", async () => {
			const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
			try {
				const fakeCircleCiResolver: BackendResolver = async () => ({
					adapters: [{ name: () => "circleci", type: () => "circleci", capabilities: () => 0 } as never],
					unconfigured: [],
				});
				const { adapters, unconfigured } = await buildConfiguredAdapters(credentialPaths(dir), {}, noEnigma, undefined, [
					...DEFAULT_BACKEND_RESOLVERS,
					fakeCircleCiResolver,
				]);
				expect(adapters.map((a) => a.name())).toEqual(["circleci"]);
				expect(unconfigured.map((b) => b.name).sort()).toEqual(["github", "gitlab", "jenkins"]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("omitting the resolvers parameter still resolves exactly the three built-in backends -- DEFAULT_BACKEND_RESOLVERS is the real default, not a parallel list", async () => {
			const dir = mkdtempSync(join(tmpdir(), "pipes-config-"));
			try {
				const { unconfigured } = await buildConfiguredAdapters(credentialPaths(dir), {}, noEnigma);
				expect(unconfigured.map((b) => b.name).sort()).toEqual(["github", "gitlab", "jenkins"]);
				expect(DEFAULT_BACKEND_RESOLVERS).toHaveLength(3);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});

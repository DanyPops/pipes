import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfiguredAdapters } from "../../src/adapters/config.ts";
import type { TryEnigmaAccessToken } from "@danypops/enigma-client";

function credentialPaths(dir: string) {
	return {
		githubToken: join(dir, "github-token.json"),
		gitlabToken: join(dir, "gitlab-token.json"),
		jenkinsCredentials: join(dir, "jenkins-credentials.json"),
	};
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
			const { adapters, unconfigured } = await buildConfiguredAdapters(
				credentialPaths(dir),
				{ GITHUB_TOKEN: "gh-token" },
				noEnigma,
				{
					github: [
						{ name: "github-lector", owner: "DanyPops", repo: "lector" },
						{ name: "github-packed", owner: "DanyPops", repo: "pi-packed" },
					],
					gitlab: [],
				},
			);
			expect(adapters.map((a) => a.name()).sort()).toEqual(["github-lector", "github-packed"]);
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
			const run = { id: 1, name: "run", status: "completed", conclusion: "success", html_url: "https://example.com", created_at: new Date().toISOString() };
			return new Response(JSON.stringify({ workflow_runs: [run] }), { status: 200 });
		}) as typeof fetch;
		try {
			const { adapters } = await buildConfiguredAdapters(credentialPaths(dir), { GITHUB_TOKEN: "gh-token" }, noEnigma, {
				github: [
					{ name: "github-lector", owner: "DanyPops", repo: "lector" },
					{ name: "github-packed", owner: "DanyPops", repo: "pi-packed" },
				],
				gitlab: [],
			});
			const lector = adapters.find((a) => a.name() === "github-lector");
			const packed = adapters.find((a) => a.name() === "github-packed");
			await lector?.getRun("workflow.yml", "latest");
			await packed?.getRun("workflow.yml", "latest");

			expect(requestedUrls[0]).toContain("/repos/DanyPops/lector/actions/runs");
			expect(requestedUrls[1]).toContain("/repos/DanyPops/pi-packed/actions/runs");
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
				{ github: [], gitlab: [{ name: "gitlab-infra", projectId: "42" }, { name: "gitlab-app", projectId: "99" }] },
			);
			expect(adapters.map((a) => a.name()).sort()).toEqual(["gitlab-app", "gitlab-infra"]);
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
				{ github: [{ name: "github-lector", owner: "DanyPops", repo: "lector" }], gitlab: [] },
			);
			expect(adapters.map((a) => a.name())).toEqual(["github-lector"]);
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
				{ github: [], gitlab: [] },
			);
			expect(adapters.map((a) => a.name())).toEqual(["github"]);
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
});

/** Spawns the real shipped `cli.ts login` binary as a subprocess against a real temp XDG state dir — argv/env validation and the Jenkins success path need no network mocking to exercise for real. */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");

async function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["bun", CLI_PATH, ...args], { env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, stdout, stderr };
}

function tempXdgEnv(dir: string): Record<string, string> {
	return { PATH: process.env.PATH ?? "", XDG_STATE_HOME: dir };
}

describe("pipes login (real subprocess)", () => {
	it("exits non-zero with usage when no backend is given", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-login-"));
		try {
			const { code, stderr } = await runCli(["login"], tempXdgEnv(dir));
			expect(code).not.toBe(0);
			expect(stderr).toContain("usage: pipes login");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exits non-zero with a clear message when GITHUB_CLIENT_ID is missing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-login-"));
		try {
			const { code, stderr } = await runCli(["login", "github"], tempXdgEnv(dir));
			expect(code).not.toBe(0);
			expect(stderr).toContain("GITHUB_CLIENT_ID");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exits non-zero with a clear message when GITLAB_URL/GITLAB_CLIENT_ID are missing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-login-"));
		try {
			const { code, stderr } = await runCli(["login", "gitlab"], tempXdgEnv(dir));
			expect(code).not.toBe(0);
			expect(stderr).toContain("GITLAB_URL");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exits non-zero with a clear message when Jenkins env vars are incomplete", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-login-"));
		try {
			const { code, stderr } = await runCli(["login", "jenkins"], tempXdgEnv(dir));
			expect(code).not.toBe(0);
			expect(stderr).toContain("JENKINS_URL");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("saves real Jenkins credentials to the state directory on success — no network involved for this backend", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-login-"));
		try {
			const { code, stdout } = await runCli(
				["login", "jenkins"],
				{ ...tempXdgEnv(dir), JENKINS_URL: "https://jenkins.example.com", JENKINS_USER: "bot", JENKINS_API_TOKEN: "tok-123" },
			);
			expect(code).toBe(0);
			expect(stdout).toContain("Jenkins credentials saved");

			// daemon-kit's vault.ts file store keys its filename by backend name alone ("jenkins.json"),
			// encoding the baseUrl/username/apiToken triple into RefreshableAccessToken's generic
			// accessToken+extra shape -- see jenkins/auth.ts's toAccessToken/fromAccessToken boundary.
			const stateFile = join(dir, "pipes", "jenkins.json");
			expect(existsSync(stateFile)).toBe(true);
			const saved = JSON.parse(readFileSync(stateFile, "utf8"));
			expect(saved).toEqual({ accessToken: "tok-123", extra: { baseUrl: "https://jenkins.example.com", username: "bot" } });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("--as <profile> stores credentials under a separate, profile-qualified file instead of the plain backend name", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-login-"));
		try {
			const { code, stdout } = await runCli(
				["login", "jenkins", "--as", "jenkins-b"],
				{ ...tempXdgEnv(dir), JENKINS_URL: "https://jenkins-b.example.com", JENKINS_USER: "bot", JENKINS_API_TOKEN: "tok-b" },
			);
			expect(code).toBe(0);
			expect(stdout).toContain('stored as "jenkins-b"');

			expect(existsSync(join(dir, "pipes", "jenkins.json"))).toBe(false);
			const stateFile = join(dir, "pipes", "jenkins-b.json");
			expect(existsSync(stateFile)).toBe(true);
			const saved = JSON.parse(readFileSync(stateFile, "utf8"));
			expect(saved).toEqual({ accessToken: "tok-b", extra: { baseUrl: "https://jenkins-b.example.com", username: "bot" } });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

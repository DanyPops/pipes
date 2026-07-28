/** Spawns the real shipped `cli.ts credentials` binary as a subprocess against a real temp XDG state dir -- pure filesystem introspection, no daemon or network involved. */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function writeCredentialFile(stateDir: string, name: string): void {
	const pipesDir = join(stateDir, "pipes");
	mkdirSync(pipesDir, { recursive: true });
	// Content is deliberately irrelevant to every test here -- list/remove never read or print it.
	writeFileSync(join(pipesDir, `${name}.json`), JSON.stringify({ accessToken: "should-never-be-printed" }));
}

describe("pipes credentials list (real subprocess)", () => {
	it("prints an empty array when no credentials directory exists yet", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-credentials-"));
		try {
			const { code, stdout } = await runCli(["credentials", "list"], tempXdgEnv(dir));
			expect(code).toBe(0);
			expect(JSON.parse(stdout)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("lists every stored profile name, sorted, with no token content ever printed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-credentials-"));
		try {
			writeCredentialFile(dir, "github-work");
			writeCredentialFile(dir, "github");
			writeCredentialFile(dir, "jenkins-a");

			const { code, stdout } = await runCli(["credentials", "list"], tempXdgEnv(dir));
			expect(code).toBe(0);
			expect(JSON.parse(stdout)).toEqual(["github", "github-work", "jenkins-a"]);
			expect(stdout).not.toContain("should-never-be-printed");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ignores non-.json files in the same directory (e.g. the daemon's own auth-token file)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-credentials-"));
		try {
			writeCredentialFile(dir, "github");
			writeFileSync(join(dir, "pipes", "token"), "daemon-auth-token-not-a-credential-profile");

			const { stdout } = await runCli(["credentials", "list"], tempXdgEnv(dir));
			expect(JSON.parse(stdout)).toEqual(["github"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("pipes credentials remove (real subprocess)", () => {
	it("deletes the named stored credential file and reports success", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-credentials-"));
		try {
			writeCredentialFile(dir, "github-work");
			const path = join(dir, "pipes", "github-work.json");
			expect(existsSync(path)).toBe(true);

			const { code, stdout } = await runCli(["credentials", "remove", "github-work"], tempXdgEnv(dir));
			expect(code).toBe(0);
			expect(stdout).toContain('Removed "github-work"');
			expect(existsSync(path)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves other stored profiles untouched", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-credentials-"));
		try {
			writeCredentialFile(dir, "github-work");
			writeCredentialFile(dir, "github-personal");

			await runCli(["credentials", "remove", "github-work"], tempXdgEnv(dir));

			expect(existsSync(join(dir, "pipes", "github-work.json"))).toBe(false);
			expect(existsSync(join(dir, "pipes", "github-personal.json"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exits non-zero with a clear message for a name that was never stored", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-credentials-"));
		try {
			const { code, stderr } = await runCli(["credentials", "remove", "nonexistent"], tempXdgEnv(dir));
			expect(code).not.toBe(0);
			expect(stderr).toContain('no stored credential named "nonexistent"');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exits non-zero with usage when no name is given", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-credentials-"));
		try {
			const { code, stderr } = await runCli(["credentials", "remove"], tempXdgEnv(dir));
			expect(code).not.toBe(0);
			expect(stderr).toContain("usage: pipes credentials remove");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("pipes credentials (real subprocess): unknown subcommand", () => {
	it("exits non-zero with usage for an unrecognized subcommand", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-credentials-"));
		try {
			const { code, stderr } = await runCli(["credentials", "bogus"], tempXdgEnv(dir));
			expect(code).not.toBe(0);
			expect(stderr).toContain("usage: pipes credentials <list|remove>");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryEnigmaCredential, tryEnigmaVaultCredential } from "../../src/adapters/enigma-source.ts";

function tmpXdg(): { dir: string; env: { XDG_RUNTIME_DIR: string; XDG_STATE_HOME: string } } {
	const dir = mkdtempSync(join(tmpdir(), "pipes-enigma-source-"));
	return { dir, env: { XDG_RUNTIME_DIR: join(dir, "run"), XDG_STATE_HOME: join(dir, "state") } };
}

describe("tryEnigmaCredential / tryEnigmaVaultCredential", () => {
	it("resolves undefined immediately when no Enigma handle file exists -- not running, not an error", async () => {
		const { dir, env } = tmpXdg();
		try {
			expect(await tryEnigmaCredential("github", { env })).toBeUndefined();
			expect(await tryEnigmaVaultCredential("github", { env })).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolves undefined when a handle exists but the token file doesn't -- never mints Enigma's own token", async () => {
		const { dir, env } = tmpXdg();
		try {
			const handleDir = join(env.XDG_RUNTIME_DIR, "enigma");
			mkdirSync(handleDir, { recursive: true });
			writeFileSync(join(handleDir, "handle.json"), JSON.stringify({ host: "127.0.0.1", port: 39218, pid: 1 }));
			expect(await tryEnigmaCredential("github", { env })).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fetches the real credential shape from a live vault when both the handle and token are present", async () => {
		const { dir, env } = tmpXdg();
		let server: ReturnType<typeof Bun.serve> | undefined;
		try {
			server = Bun.serve({
				port: 0,
				fetch(request) {
					if (request.headers.get("authorization") !== "Bearer fixture-enigma-bearer") return new Response("unauthorized", { status: 401 });
					const url = new URL(request.url);
					if (url.pathname === "/creds/jenkins") {
						return new Response(JSON.stringify({ accessToken: "fixture-jenkins-token", extra: { url: "https://jenkins.example.com", username: "bot" } }), {
							headers: { "content-type": "application/json" },
						});
					}
					return new Response("not found", { status: 404 });
				},
			});

			const handleDir = join(env.XDG_RUNTIME_DIR, "enigma");
			const stateDir = join(env.XDG_STATE_HOME, "enigma");
			mkdirSync(handleDir, { recursive: true });
			mkdirSync(stateDir, { recursive: true });
			writeFileSync(join(handleDir, "handle.json"), JSON.stringify({ host: "127.0.0.1", port: server.port, pid: process.pid }));
			writeFileSync(join(stateDir, "token"), "fixture-enigma-bearer\n");

			const full = await tryEnigmaVaultCredential("jenkins", { env });
			expect(full).toEqual({ accessToken: "fixture-jenkins-token", extra: { url: "https://jenkins.example.com", username: "bot" } });

			const bare = await tryEnigmaCredential("jenkins", { env });
			expect(bare).toBe("fixture-jenkins-token");

			const missing = await tryEnigmaCredential("gitlab", { env });
			expect(missing).toBeUndefined(); // real 404 -- backend not configured in the vault
		} finally {
			server?.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never throws and resolves undefined when the vault is unreachable", async () => {
		const { dir, env } = tmpXdg();
		try {
			const handleDir = join(env.XDG_RUNTIME_DIR, "enigma");
			const stateDir = join(env.XDG_STATE_HOME, "enigma");
			mkdirSync(handleDir, { recursive: true });
			mkdirSync(stateDir, { recursive: true });
			writeFileSync(join(handleDir, "handle.json"), JSON.stringify({ host: "127.0.0.1", port: 1, pid: process.pid }));
			writeFileSync(join(stateDir, "token"), "fixture-enigma-bearer\n");
			expect(await tryEnigmaCredential("github", { env })).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

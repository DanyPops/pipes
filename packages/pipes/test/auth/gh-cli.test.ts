import { describe, expect, it } from "bun:test";
import { readGhCliToken, type SpawnLike } from "../../src/auth/gh-cli.ts";

function fakeSpawn(options: { stdout?: string; code: number }): SpawnLike {
	return () => ({
		stdout: new Response(options.stdout ?? "").body as ReadableStream<Uint8Array>,
		exited: Promise.resolve(options.code),
	});
}

describe("readGhCliToken", () => {
	it("resolves the trimmed token on success", async () => {
		const result = await readGhCliToken(undefined, fakeSpawn({ stdout: "gho_realtoken\n", code: 0 }));
		expect(result).toEqual({ ok: true, token: "gho_realtoken" });
	});

	it("passes --user through to gh's own multi-account selection", async () => {
		const calls: string[][] = [];
		const spawn: SpawnLike = (command) => {
			calls.push(command);
			return { stdout: new Response("gho_danypops\n").body as ReadableStream<Uint8Array>, exited: Promise.resolve(0) };
		};
		await readGhCliToken("DanyPops", spawn);
		expect(calls).toEqual([["gh", "auth", "token", "--user", "DanyPops"]]);
	});

	it("reports a clear, distinguishing error for an unknown --user account rather than a raw exit code", async () => {
		const result = await readGhCliToken("nonexistent", fakeSpawn({ code: 1 }));
		expect(result).toEqual({ ok: false, reason: 'gh CLI has no authenticated account named "nonexistent" -- run `gh auth login` first' });
	});

	it("reports a clear error when gh CLI has no active account at all", async () => {
		const result = await readGhCliToken(undefined, fakeSpawn({ code: 1 }));
		expect(result).toEqual({ ok: false, reason: "gh CLI is not authenticated -- run `gh auth login` first" });
	});

	it("reports a clear error when the gh binary itself can't be spawned", async () => {
		const spawn: SpawnLike = () => {
			throw new Error("ENOENT");
		};
		const result = await readGhCliToken(undefined, spawn);
		expect(result).toEqual({ ok: false, reason: "gh CLI not found -- install it (cli.github.com) or use a different login method" });
	});

	it("reports a clear error rather than an empty-string token when gh exits 0 with no output", async () => {
		const result = await readGhCliToken(undefined, fakeSpawn({ stdout: "", code: 0 }));
		expect(result).toEqual({ ok: false, reason: "gh auth token returned no token" });
	});
});

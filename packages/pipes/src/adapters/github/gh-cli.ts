/**
 * Optional shortcut: reuse an already-authenticated `gh` CLI session
 * instead of running pipes' own OAuth device flow. Mirrors packed's own
 * `npm login --auth-type=web` pattern -- never re-implement a vendor
 * CLI's auth, just delegate to it and consume the result.
 *
 * Deliberately shells out to `gh auth token` rather than reading gh's own
 * credential storage directly: gh's default "secure storage" keeps the
 * token in the OS keyring (Secret Service/libsecret on Linux, Keychain on
 * macOS, Credential Manager on Windows) under an internal, undocumented
 * schema -- not a published contract, and not guaranteed stable across gh
 * versions. `gh auth token` is gh's own documented, stable interface for
 * exactly this scripting use case, abstracting over wherever the
 * credential actually lives. The token never touches this process's own
 * stdout/log output, only the returned string.
 */
export type GhCliTokenResult = { ok: true; token: string } | { ok: false; reason: string };

export interface SpawnLike {
	(command: string[]): { stdout: ReadableStream<Uint8Array> | number; exited: Promise<number> };
}

const defaultSpawn: SpawnLike = (command) => Bun.spawn(command, { stdout: "pipe" });

/**
 * Reads `gh auth token`'s output for the given account (gh's own `--user`
 * flag; omit to use gh's currently active account). Never mints, never
 * prompts, never falls back to a device flow itself.
 */
export async function readGhCliToken(user?: string, spawn: SpawnLike = defaultSpawn): Promise<GhCliTokenResult> {
	const command = user ? ["gh", "auth", "token", "--user", user] : ["gh", "auth", "token"];
	let proc: ReturnType<SpawnLike>;
	try {
		proc = spawn(command);
	} catch {
		return { ok: false, reason: "gh CLI not found -- install it (cli.github.com) or use a different login method" };
	}
	const [stdout, code] = await Promise.all([
		proc.stdout instanceof ReadableStream ? new Response(proc.stdout).text() : Promise.resolve(""),
		proc.exited,
	]);
	if (code !== 0) {
		return { ok: false, reason: user ? `gh CLI has no authenticated account named "${user}" -- run \`gh auth login\` first` : "gh CLI is not authenticated -- run `gh auth login` first" };
	}
	const token = stdout.trim();
	if (!token) return { ok: false, reason: "gh auth token returned no token" };
	return { ok: true, token };
}

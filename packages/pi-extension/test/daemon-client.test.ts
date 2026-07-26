/** Covers daemon-client.ts's duplicated path/token/handle logic directly (see its own doc comment for why it duplicates rather than imports). */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	connectOrStartPipesClient,
	connectPipesClient,
	ensureAuthToken,
	type PipesPaths,
	readDaemonHandle,
	resolvePipesPaths,
} from "../src/daemon-client.ts";

function tempPaths(): { root: string; paths: PipesPaths; env: Record<string, string> } {
	const root = mkdtempSync(join(tmpdir(), "pi-pipes-client-"));
	const env = {
		...(process.env as Record<string, string>),
		XDG_STATE_HOME: join(root, "state"),
		XDG_RUNTIME_DIR: join(root, "run"),
	};
	return { root, paths: resolvePipesPaths({ env, home: root, uid: 1000 }), env };
}

describe("resolvePipesPaths", () => {
	it("places token and handle under the correct XDG roots", () => {
		const { paths } = tempPaths();
		expect(paths.token).toContain(join("state", "pipes", "auth-token"));
		expect(paths.handle).toContain(join("run", "pipes", "daemon.json"));
	});
});

describe("ensureAuthToken", () => {
	it("creates a 64-char hex token and reuses it on subsequent calls", () => {
		const { root, paths } = tempPaths();
		try {
			const first = ensureAuthToken(paths);
			expect(first).toMatch(/^[a-f0-9]{64}$/);
			expect(ensureAuthToken(paths)).toBe(first);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a corrupted token file rather than silently accepting bad content", () => {
		const { root, paths } = tempPaths();
		try {
			ensureAuthToken(paths);
			writeFileSync(paths.token, "not-a-valid-token\n");
			expect(() => ensureAuthToken(paths)).toThrow(/invalid Pipes authentication token/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("readDaemonHandle", () => {
	it("returns null when no handle file exists", () => {
		const { paths } = tempPaths();
		expect(readDaemonHandle(paths)).toBeNull();
	});

	it("returns null for a malformed handle file", () => {
		const { root, paths } = tempPaths();
		try {
			mkdirSync(dirname(paths.handle), { recursive: true });
			writeFileSync(paths.handle, JSON.stringify({ host: "not-loopback", port: 1, pid: 1 }));
			expect(readDaemonHandle(paths)).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("connectPipesClient", () => {
	it("throws a clear error when the daemon is not running", () => {
		const { paths } = tempPaths();
		expect(() => connectPipesClient(paths)).toThrow(/Pipes daemon is not running/);
	});
});

describe("connectOrStartPipesClient: real subprocess", () => {
	let spawnedPid: number | undefined;
	let tempRoot: string | undefined;

	afterEach(() => {
		if (spawnedPid) {
			try {
				process.kill(spawnedPid, "SIGKILL");
			} catch {
				// already gone
			}
			spawnedPid = undefined;
		}
		if (tempRoot) {
			rmSync(tempRoot, { recursive: true, force: true });
			tempRoot = undefined;
		}
	});

	/**
	 * Regression test for a real, live-confirmed bug: a workspace install (bun
	 * or npm) can leave a stale materialized copy of @danypops/pipes nested
	 * under this package's own node_modules, shadowing the live workspace
	 * sibling. resolveDaemonCliPath() must always spawn the real sibling
	 * packages/pipes/src/cli.ts, never a node_modules copy that can go stale.
	 */
	it("spawns the live monorepo sibling packages/pipes/src/cli.ts, not a node_modules copy", async () => {
		const { root, paths, env } = tempPaths();
		tempRoot = root;

		const client = await connectOrStartPipesClient(paths, { env });
		const handle = readDaemonHandle(paths);
		expect(handle).not.toBeNull();
		spawnedPid = handle?.pid;

		const cmdline = readFileSync(`/proc/${handle?.pid}/cmdline`, "utf8").split("\0").filter(Boolean);
		const cliArg = cmdline.find((part) => part.endsWith("cli.ts"));
		expect(cliArg).toContain(join("packages", "pipes", "src", "cli.ts"));
		expect(cliArg).not.toContain("node_modules");

		const health = await client.health();
		expect(health.ok).toBe(true);
	});
});

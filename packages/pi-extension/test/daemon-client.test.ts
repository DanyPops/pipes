/** Covers daemon-client.ts's duplicated path/token/handle logic directly (see its own doc comment for why it duplicates rather than imports). */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	connectPipesClient,
	ensureAuthToken,
	type PipesPaths,
	readDaemonHandle,
	resolvePipesPaths,
} from "../src/daemon-client.ts";

function tempPaths(): { root: string; paths: PipesPaths } {
	const root = mkdtempSync(join(tmpdir(), "pi-pipes-daemon-client-"));
	const env = {
		...(process.env as Record<string, string>),
		XDG_STATE_HOME: join(root, "state"),
		XDG_RUNTIME_DIR: join(root, "run"),
	};
	return { root, paths: resolvePipesPaths({ env, home: root, uid: 1000 }) };
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

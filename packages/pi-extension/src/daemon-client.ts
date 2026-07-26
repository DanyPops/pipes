/**
 * Authenticated Pipes daemon client, duplicated (not imported) from
 * @danypops/pipes's paths.ts/client.ts: pi loads extensions through
 * module-resolution paths that do not reliably transpile a dependency's
 * raw Bun-targeted TypeScript. This file only needs @danypops/pipes
 * installed as files on disk, to locate and spawn its cli.ts — it never
 * imports that package's code.
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LOOPBACK_HOST = "127.0.0.1";
const STATE_DIRECTORY_NAME = "pipes";
const TOKEN_FILENAME = "auth-token";
const HANDLE_FILENAME = "daemon.json";
const DAEMON_START_TIMEOUT_MS = 5_000;
const DAEMON_START_POLL_INTERVAL_MS = 100;

export interface PipesPaths {
	token: string;
	handle: string;
}

export interface DaemonHandle {
	host: typeof LOOPBACK_HOST;
	port: number;
	pid: number;
}

interface PathEnvironment {
	env?: Record<string, string | undefined>;
	home?: string;
	uid?: number;
}

export function resolvePipesPaths(options: PathEnvironment = {}): PipesPaths {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const uid = options.uid ?? process.getuid?.() ?? 0;
	const stateHome = env.XDG_STATE_HOME ?? join(home, ".local", "state");
	const runtimeHome = env.XDG_RUNTIME_DIR ?? join("/run", "user", String(uid));
	return {
		token: join(stateHome, STATE_DIRECTORY_NAME, TOKEN_FILENAME),
		handle: join(runtimeHome, STATE_DIRECTORY_NAME, HANDLE_FILENAME),
	};
}

export function ensureAuthToken(paths: PipesPaths): string {
	mkdirSync(dirname(paths.token), { recursive: true, mode: 0o700 });
	if (existsSync(paths.token)) {
		chmodSync(paths.token, 0o600);
		const token = readFileSync(paths.token, "utf8").trim();
		if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("invalid Pipes authentication token");
		return token;
	}
	const token = randomBytes(32).toString("hex");
	writeFileSync(paths.token, `${token}\n`, { mode: 0o600 });
	return token;
}

export function readDaemonHandle(paths: PipesPaths): DaemonHandle | null {
	try {
		const value = JSON.parse(readFileSync(paths.handle, "utf8")) as Partial<DaemonHandle>;
		if (
			value.host !== LOOPBACK_HOST ||
			!Number.isInteger(value.port) ||
			(value.port as number) < 1 ||
			(value.port as number) > 65_535 ||
			!Number.isInteger(value.pid)
		) {
			return null;
		}
		return value as DaemonHandle;
	} catch {
		return null;
	}
}

export type FetchTransport = (request: Request) => Promise<Response>;

export class PipesClient {
	constructor(
		private readonly baseUrl: string,
		private readonly token: string,
		private readonly transport: FetchTransport = fetch,
	) {}

	async call<T = unknown>(operation: string, input: Record<string, unknown>): Promise<T> {
		const response = await this.transport(
			new Request(`${this.baseUrl}/api/v1/ops`, {
				method: "POST",
				headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
				body: JSON.stringify({ op: operation, input }),
			}),
		);
		const body = (await response.json()) as { result?: T; error?: string };
		if (!response.ok) throw new Error(body.error ?? `Pipes operation failed with HTTP ${response.status}`);
		return body.result as T;
	}

	async health(): Promise<{ ok: true; version: string }> {
		const response = await this.transport(
			new Request(`${this.baseUrl}/health`, { headers: { authorization: `Bearer ${this.token}` } }),
		);
		const body = (await response.json()) as { ok?: boolean; version?: string; error?: string };
		if (!response.ok || body.ok !== true || typeof body.version !== "string") {
			throw new Error(body.error ?? "Pipes health check failed");
		}
		return { ok: true, version: body.version };
	}
}

export function connectPipesClient(paths: PipesPaths = resolvePipesPaths()): PipesClient {
	const handle = readDaemonHandle(paths);
	if (!handle) throw new Error("Pipes daemon is not running");
	const token = ensureAuthToken(paths);
	return new PipesClient(`http://${handle.host}:${handle.port}`, token);
}

/** Resolves the installed @danypops/pipes package's cli.ts on disk — no code import, path only. */
function resolveDaemonCliPath(): string {
	const require = createRequire(import.meta.url);
	const packageJsonPath = require.resolve("@danypops/pipes/package.json");
	return join(dirname(packageJsonPath), "src", "cli.ts");
}

async function waitForHandle(paths: PipesPaths, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (readDaemonHandle(paths)) return true;
		await new Promise((resolve) => setTimeout(resolve, DAEMON_START_POLL_INTERVAL_MS));
	}
	return false;
}

export interface ConnectOrStartOptions {
	env?: Record<string, string | undefined>;
}

export async function connectOrStartPipesClient(
	paths: PipesPaths = resolvePipesPaths(),
	options: ConnectOrStartOptions = {},
): Promise<PipesClient> {
	if (readDaemonHandle(paths)) {
		try {
			return connectPipesClient(paths);
		} catch {
			// Stale/unreadable handle — fall through and (re)start.
		}
	}

	let cliPath: string;
	try {
		cliPath = resolveDaemonCliPath();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Pipes daemon package not found (${message}); run \`pi install npm:@danypops/pipes\`.`);
	}

	const child = spawn(cliPath, ["serve"], { detached: true, stdio: "ignore", env: options.env ?? process.env });
	child.unref();

	const started = await waitForHandle(paths, DAEMON_START_TIMEOUT_MS);
	if (!started) {
		throw new Error("Pipes daemon failed to start automatically; run `pipes serve` manually.");
	}
	return connectPipesClient(paths);
}

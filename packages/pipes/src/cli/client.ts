/**
 * Typed daemon client for in-process/CLI use. The pi-pipes package
 * intentionally does not import this: it duplicates the path/token/client
 * subset instead, because pi loads extensions through module-resolution
 * paths that do not reliably transpile a dependency's raw Bun-targeted
 * TypeScript.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthenticatedRpcClient } from "@danypops/vehicle-client/rpc-client";
import type { DaemonHandle } from "@danypops/vehicle-server/paths";
import { ensureAuthToken, readDaemonHandle } from "@danypops/vehicle-server/paths";
import { resolvePipesPaths } from "../paths.ts";
import type { OperationInputs, OperationName, OperationOutputs } from "../rpc/service.ts";
import { packageRoot } from "./package-root.ts";

export type PipesClient = AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>;

export function connectPipesClient(paths = resolvePipesPaths()): PipesClient {
	const handle = readDaemonHandle(paths.handle);
	if (!handle) throw new Error("Pipes daemon is not running; run `pipes serve`.");
	const token = ensureAuthToken(paths.token, "Pipes");
	return new AuthenticatedRpcClient(`http://${handle.host}:${handle.port}`, token, { label: "Pipes" });
}

async function isAlive(handle: DaemonHandle, token: string): Promise<boolean> {
	try {
		const res = await fetch(`http://${handle.host}:${handle.port}/health`, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(500),
		});
		return res.ok;
	} catch {
		return false;
	}
}

/** Absolute path to this package's own `pipes serve` entry point -- always resolved relative to this file, since (unlike a consumer package) this is the real source, never a sibling workspace fallback. */
export function resolveDaemonEntryPath(): string {
	const root = packageRoot(dirname(fileURLToPath(import.meta.url)));
	return join(root, "src", "cli", "index.ts");
}

function spawnDaemon(): void {
	const child = spawn("bun", [resolveDaemonEntryPath(), "serve"], { detached: true, stdio: "ignore" });
	child.unref();
}

async function waitForHandle(handlePath: string, timeoutMs: number): Promise<DaemonHandle | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const handle = readDaemonHandle(handlePath);
		if (handle) return handle;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return null;
}

export interface EnsureDaemonOptions {
	/** false: fail immediately with a clear message instead of spawning the daemon. */
	autoStart?: boolean;
	timeoutMs?: number;
}

const DEFAULT_SPAWN_TIMEOUT_MS = 5_000;

export async function ensureDaemonRunning(opts: EnsureDaemonOptions = {}): Promise<{ baseUrl: string; token: string }> {
	const paths = resolvePipesPaths();
	const token = ensureAuthToken(paths.token, "Pipes");

	const existing = readDaemonHandle(paths.handle);
	if (existing && (await isAlive(existing, token))) {
		return { baseUrl: `http://${existing.host}:${existing.port}`, token };
	}

	if (opts.autoStart === false) {
		throw new Error("Pipes daemon is not running. Start it with `pipes serve`.");
	}

	spawnDaemon();
	const handle = await waitForHandle(paths.handle, opts.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS);
	if (!handle || !(await isAlive(handle, token))) {
		throw new Error("Pipes daemon did not become ready within the timeout");
	}
	return { baseUrl: `http://${handle.host}:${handle.port}`, token };
}

/** Spawns the daemon on first use if it isn't already running, then returns a connected RPC client -- the CLI/TUI counterpart to resolveVehicleClientTarget's non-spawning read. */
export async function createPipesClient(opts: EnsureDaemonOptions = {}): Promise<PipesClient> {
	const { baseUrl, token } = await ensureDaemonRunning(opts);
	return new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>(baseUrl, token, { label: "Pipes" });
}

export interface VehicleClientTarget {
	/** Base URL for Pipes' VehicleRegistry (see ../vehicle/pipes-vehicle.ts) -- @danypops/vehicle-client's RemoteVehicleClient mounts its own /vehicle/manifest, /vehicle/invoke, /vehicle/cancel routes under this. */
	baseUrl: string;
	token: string;
}

/**
 * Narrow, side-effect-free surface for a Vehicle-projected domain consumer.
 * Deliberately does NOT call ensureDaemonRunning: that spawns the daemon and
 * mints a fresh auth token file as a side effect, which is wrong to do just
 * from a Pi extension loading and registering its tool schemas -- only reads
 * the handle if the daemon has already started, mirroring @danypops/tickets'
 * own resolveVehicleClientTarget().
 */
export function resolveVehicleClientTarget(env?: Record<string, string | undefined>): VehicleClientTarget | undefined {
	const paths = resolvePipesPaths({ env });
	const handle = readDaemonHandle(paths.handle);
	if (!handle) return undefined;
	const token = ensureAuthToken(paths.token, "Pipes");
	return { baseUrl: `http://${handle.host}:${handle.port}`, token };
}

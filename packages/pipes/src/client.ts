/**
 * Typed daemon client for in-process/CLI use. The pi-pipes package
 * intentionally does not import this: it duplicates the path/token/client
 * subset instead, because pi loads extensions through module-resolution
 * paths that do not reliably transpile a dependency's raw Bun-targeted
 * TypeScript.
 */
import { ensureAuthToken, readDaemonHandle } from "@danypops/vehicle-server/paths";
import { AuthenticatedRpcClient } from "@danypops/vehicle-client/rpc-client";
import { resolvePipesPaths } from "./paths.ts";
import type { OperationInputs, OperationName, OperationOutputs } from "./service.ts";

export type PipesClient = AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>;

export function connectPipesClient(paths = resolvePipesPaths()): PipesClient {
	const handle = readDaemonHandle(paths.handle);
	if (!handle) throw new Error("Pipes daemon is not running; run `pipes serve`.");
	const token = ensureAuthToken(paths.token, "Pipes");
	return new AuthenticatedRpcClient(`http://${handle.host}:${handle.port}`, token, { label: "Pipes" });
}

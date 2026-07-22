/** Operation registry + fetch handler: bearer auth, /health, /ready, /api/v1/ops. */
import { errorResponse, healthResponse, jsonResponse, readyResponse, requireBearerToken } from "@danypops/daemon-kit/http";
import { VERSION } from "./version.ts";

export type OperationName = "backends.list";

export interface OperationInputs {
	"backends.list": Record<string, never>;
}

export interface OperationOutputs {
	"backends.list": { backends: string[] };
}

export class UnknownOperationError extends Error {
	constructor(op: string) {
		super(`unknown operation: ${op}`);
	}
}

export interface PipesService {
	operationNames(): OperationName[];
	execute<Name extends OperationName>(op: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]>;
}

export function createPipesService(): PipesService {
	return {
		operationNames(): OperationName[] {
			return ["backends.list"];
		},
		async execute<Name extends OperationName>(op: Name, _input: OperationInputs[Name]): Promise<OperationOutputs[Name]> {
			if (op === "backends.list") {
				return { backends: [] } as OperationOutputs[Name];
			}
			throw new UnknownOperationError(op);
		},
	};
}

async function readOperationBody(request: Request): Promise<{ op?: unknown; input?: unknown }> {
	return (await request.json()) as { op?: unknown; input?: unknown };
}

export function createApp(deps: { service: PipesService; token: string }): { fetch(request: Request): Promise<Response> } {
	return {
		async fetch(request: Request): Promise<Response> {
			if (!requireBearerToken(request, deps.token)) {
				return errorResponse("missing or invalid bearer token", 401);
			}
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/health") {
				return healthResponse(VERSION);
			}
			if (request.method === "GET" && url.pathname === "/ready") {
				return readyResponse(true);
			}
			if (request.method === "GET" && url.pathname === "/api/v1/ops") {
				return jsonResponse({ operations: deps.service.operationNames() });
			}
			if (request.method === "POST" && url.pathname === "/api/v1/ops") {
				try {
					const body = await readOperationBody(request);
					if (typeof body.op !== "string") return errorResponse("op is required", 400);
					const input = body.input === undefined ? {} : body.input;
					if (typeof input !== "object" || input === null || Array.isArray(input)) {
						return errorResponse("input must be an object", 400);
					}
					const result = await deps.service.execute(body.op as OperationName, input as OperationInputs[OperationName]);
					return jsonResponse({ result });
				} catch (error) {
					const status = error instanceof UnknownOperationError ? 404 : 400;
					return errorResponse(error instanceof Error ? error.message : String(error), status);
				}
			}
			return errorResponse("not found", 404);
		},
	};
}

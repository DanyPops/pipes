/**
 * ci.wait's own single blocking call returns nothing until the whole run
 * finishes -- a caller watching a real deploy stares at nothing for the
 * entire duration. This ticks ci.wait with a short per-tick timeout budget
 * (already blocks server-side until terminal or that tick's budget elapses,
 * so no separate client-side sleep/timer is needed) and pairs each tick
 * with a ci.tail call for the actual log text ci.wait's own shape doesn't
 * carry, streaming the combined snapshot via onUpdate on every tick.
 *
 * Only used for the "watch an existing run" form (jobRef+runId given); the
 * opaqueRef-resolve form (turning a fresh trigger's receipt into a real run
 * id) has no run to tail yet, so it keeps using a single plain ci.wait call.
 */
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { PipesClient } from "./daemon-client.ts";

const WAIT_TICK_TIMEOUT_S = 20;
const WAIT_DEFAULT_TOTAL_TIMEOUT_S = 3600;

/** Mirrors packages/pipes's own RunStatus terminal set (isTerminalStatus in domain/ci-run.ts) -- duplicated, not imported, matching this file's own duplicated-client pattern. */
const TERMINAL_STATUSES = new Set(["success", "failure", "aborted", "not_found"]);

export interface WaitStreamParams {
	backend: string;
	jobRef: string;
	runId: string;
	timeoutS?: number;
	maxTokens?: number;
}

export interface WaitStreamTail {
	text: string;
	truncated: boolean;
	totalTokens: number;
	outputTokens: number;
}

export async function waitAndStreamTail(
	client: PipesClient,
	params: WaitStreamParams,
	onUpdate: AgentToolUpdateCallback | undefined,
	signal: AbortSignal | undefined,
	now: () => number = Date.now,
): Promise<Record<string, unknown>> {
	const deadline = now() + (params.timeoutS ?? WAIT_DEFAULT_TOTAL_TIMEOUT_S) * 1000;
	let result: Record<string, unknown> = {};

	for (;;) {
		if (signal?.aborted || now() >= deadline) break;

		const remainingS = Math.max(1, Math.ceil((deadline - now()) / 1000));
		const tickTimeoutS = Math.min(WAIT_TICK_TIMEOUT_S, remainingS);

		const status = await client.call<Record<string, unknown>>("ci.wait", { backend: params.backend, jobRef: params.jobRef, runId: params.runId, timeoutS: tickTimeoutS });
		const tail = await client.call<WaitStreamTail>("ci.tail", { backend: params.backend, jobRef: params.jobRef, runId: params.runId, maxTokens: params.maxTokens });
		result = { ...status, tail };

		const patch: AgentToolResult<{ result: Record<string, unknown> }> = { content: [{ type: "text", text: JSON.stringify(result) }], details: { result } };
		onUpdate?.(patch);

		const runStatus = status.status;
		if (typeof runStatus === "string" && TERMINAL_STATUSES.has(runStatus)) break;
	}

	return result;
}

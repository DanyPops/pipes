/**
 * Log-tail truncation for the local log cache's default read. Ported from
 * pi-mono's own conventions rather than invented fresh, so an agent sees
 * consistent output sizing everywhere: tail-based (keep the END, where CI
 * failures live, matching pi-mono's truncateTail for bash output) and the
 * same ~4-chars-per-token estimate pi-mono's own context accounting uses
 * (packages/ai/src/utils/estimate.ts's CHARS_PER_TOKEN), not a
 * differently-tuned heuristic that would make sizes surprising.
 */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface LogTailResult {
	text: string;
	truncated: boolean;
	totalTokens: number;
	outputTokens: number;
}

/** Keeps complete lines from the end that fit within maxTokens; a single line alone exceeding the budget falls back to a raw character slice rather than returning nothing. */
export function tailByTokenBudget(text: string, maxTokens: number): LogTailResult {
	const totalTokens = estimateTokens(text);
	if (totalTokens <= maxTokens) {
		return { text, truncated: false, totalTokens, outputTokens: totalTokens };
	}

	const maxChars = maxTokens * CHARS_PER_TOKEN;
	const lines = text.split("\n");
	const kept: string[] = [];
	let chars = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i] as string;
		const lineChars = line.length + (kept.length > 0 ? 1 : 0);
		if (chars + lineChars > maxChars) break;
		kept.unshift(line);
		chars += lineChars;
	}

	const outputText = kept.length > 0 ? kept.join("\n") : text.slice(-maxChars);
	return { text: outputText, truncated: true, totalTokens, outputTokens: estimateTokens(outputText) };
}

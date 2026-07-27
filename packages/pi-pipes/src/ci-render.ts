/**
 * Human-facing TUI rendering for the ci tool, kept separate from ci-tool.ts's
 * LLM-facing execute()/schema. content (JSON) and this render path are two
 * genuinely different channels reading the same result: content is exact and
 * complete for the model, this is compact and scannable for a human, and
 * always surfaces a clickable URL when the underlying data has one.
 */
import { hyperlink } from "@earendil-works/pi-tui";

const MAX_URL_SEARCH_DEPTH = 6;
const MAX_URL_SEARCH_NODES = 500;

/**
 * Finds the first string field literally named "url" anywhere in the result,
 * breadth-first so a top-level url (the common case) always wins over one
 * buried in a nested array. Bounded so a large search/pool/chain result can't
 * make this walk unbounded work.
 */
export function findFirstUrl(value: unknown): string | undefined {
	const queue: unknown[] = [value];
	let visited = 0;
	let depth = 0;
	while (queue.length > 0 && depth <= MAX_URL_SEARCH_DEPTH && visited < MAX_URL_SEARCH_NODES) {
		const levelSize = queue.length;
		for (let i = 0; i < levelSize; i++) {
			const node = queue.shift();
			visited++;
			if (visited > MAX_URL_SEARCH_NODES) break;
			if (!node || typeof node !== "object") continue;
			const record = node as Record<string, unknown>;
			if (typeof record.url === "string" && record.url.length > 0) return record.url;
			for (const child of Object.values(record)) {
				if (child && typeof child === "object") queue.push(child);
			}
		}
		depth++;
	}
	return undefined;
}

const STATUS_ICON: Record<string, { glyph: string; color: string }> = {
	success: { glyph: "✓", color: "success" },
	failure: { glyph: "✗", color: "error" },
	running: { glyph: "●", color: "warning" },
	pending: { glyph: "○", color: "muted" },
	aborted: { glyph: "⊘", color: "muted" },
	not_found: { glyph: "?", color: "dim" },
};

export function statusGlyph(status: string | undefined, theme: { fg(color: string, text: string): string }): string {
	const known = status ? STATUS_ICON[status] : undefined;
	if (!known) return theme.fg("dim", status ?? "unknown");
	return theme.fg(known.color, `${known.glyph} ${status}`);
}

/** Wraps a URL as a clickable OSC 8 hyperlink (plain text on terminals without support) with a leading label. */
export function openLine(url: string, theme: { fg(color: string, text: string): string }): string {
	return theme.fg("dim", "Open: ") + theme.fg("accent", hyperlink(url, url));
}

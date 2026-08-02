/**
 * Loads named pipeline presets from a human-edited config file — the agent
 * never authors or sees this file, only the resulting preset names (see
 * conty's config.yaml Pipelines section, ported here). JSON rather than
 * YAML: this is a small, flat structure with no need for comments or
 * anchors, so a full YAML parser dependency isn't justified for what little
 * generic parsing code it would replace.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Pipeline } from "../run/pipeline.ts";

export interface PresetsFile {
	pipelines: Pipeline[];
}

export function defaultPresetsPath(env: Record<string, string | undefined> = process.env, home = homedir()): string {
	const configHome = env.XDG_CONFIG_HOME ?? join(home, ".config");
	return join(configHome, "pipes", "pipelines.json");
}

/** Returns [] when the file doesn't exist yet — presets are optional, not required to boot. */
export function loadPresets(path: string): Pipeline[] {
	if (!existsSync(path)) return [];
	const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PresetsFile>;
	if (!Array.isArray(parsed.pipelines)) {
		throw new Error(`${path}: expected a top-level "pipelines" array`);
	}
	return parsed.pipelines;
}

/**
 * Persists the full preset set back to the same human-edited file loadPresets reads,
 * so a management UI's add/edit/remove survives a daemon restart, not just the
 * in-memory registry. Atomic write-then-rename so a concurrent reader (or a human's
 * editor) never observes a half-written file.
 */
export function savePresets(path: string, pipelines: Pipeline[]): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	const file: PresetsFile = { pipelines };
	writeFileSync(temporary, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
	renameSync(temporary, path);
}

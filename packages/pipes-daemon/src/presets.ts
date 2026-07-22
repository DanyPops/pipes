/**
 * Loads named pipeline presets from a human-edited config file — the agent
 * never authors or sees this file, only the resulting preset names (see
 * conty's config.yaml Pipelines section, ported here). JSON rather than
 * YAML: this is a small, flat structure with no need for comments or
 * anchors, so a full YAML parser dependency isn't justified for what little
 * generic parsing code it would replace.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Pipeline } from "./domain/pipeline.ts";

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

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { Pipeline } from "../src/domain/pipeline.ts";
import { defaultPresetsPath, loadPresets, savePresets } from "../src/presets.ts";

let dir: string | undefined;

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

describe("defaultPresetsPath", () => {
	it("resolves under XDG_CONFIG_HOME/pipes/pipelines.json", () => {
		const path = defaultPresetsPath({ XDG_CONFIG_HOME: "/config" }, "/home/x");
		expect(path).toBe("/config/pipes/pipelines.json");
	});

	it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
		const path = defaultPresetsPath({}, "/home/x");
		expect(path).toBe("/home/x/.config/pipes/pipelines.json");
	});
});

describe("loadPresets", () => {
	it("returns [] when the file doesn't exist -- presets are optional", () => {
		dir = mkdtempSync(join(tmpdir(), "pipes-presets-"));
		expect(loadPresets(join(dir, "missing.json"))).toEqual([]);
	});

	it("throws on a file whose top-level shape isn't {pipelines: [...]}", () => {
		dir = mkdtempSync(join(tmpdir(), "pipes-presets-"));
		const path = join(dir, "pipelines.json");
		Bun.write(path, JSON.stringify({ notPipelines: [] }));
		expect(() => loadPresets(path)).toThrow(/expected a top-level "pipelines" array/);
	});
});

describe("savePresets / loadPresets round-trip", () => {
	it("persists and reloads the exact same preset set", () => {
		dir = mkdtempSync(join(tmpdir(), "pipes-presets-"));
		const path = join(dir, "nested", "pipelines.json");
		const pipelines: Pipeline[] = [
			{ name: "deploy", backend: "github", steps: [{ jobName: "build" }, { jobName: "deploy", params: { env: "prod" } }] },
			{ name: "smoke-test", backend: "gitlab", steps: [{ jobName: "smoke" }] },
		];

		savePresets(path, pipelines);

		expect(loadPresets(path)).toEqual(pipelines);
	});

	it("creates parent directories that don't exist yet", () => {
		dir = mkdtempSync(join(tmpdir(), "pipes-presets-"));
		const path = join(dir, "a", "b", "c", "pipelines.json");
		savePresets(path, []);
		expect(loadPresets(path)).toEqual([]);
	});

	it("overwrites a previous save entirely -- the file reflects only the latest set passed in", () => {
		dir = mkdtempSync(join(tmpdir(), "pipes-presets-"));
		const path = join(dir, "pipelines.json");
		savePresets(path, [{ name: "old", backend: "github", steps: [{ jobName: "x" }] }]);

		savePresets(path, [{ name: "new", backend: "gitlab", steps: [{ jobName: "y" }] }]);

		const loaded = loadPresets(path);
		expect(loaded).toHaveLength(1);
		expect(loaded[0]?.name).toBe("new");
	});

	it("writes the file with restrictive permissions, never leaving world/group-readable preset data", () => {
		dir = mkdtempSync(join(tmpdir(), "pipes-presets-"));
		const path = join(dir, "pipelines.json");
		savePresets(path, [{ name: "p", backend: "github", steps: [] }]);

		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("leaves no temp file behind after a successful save", () => {
		dir = mkdtempSync(join(tmpdir(), "pipes-presets-"));
		const path = join(dir, "pipelines.json");
		savePresets(path, [{ name: "p", backend: "github", steps: [] }]);

		const remaining = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
		expect(remaining).toEqual([]);
	});
});

// Sanity: the JSON file a human would actually read/edit is pretty-printed, not minified.
describe("savePresets output format", () => {
	it("pretty-prints with tab indentation for human editability", () => {
		dir = mkdtempSync(join(tmpdir(), "pipes-presets-"));
		const path = join(dir, "pipelines.json");
		savePresets(path, [{ name: "p", backend: "github", steps: [{ jobName: "build" }] }]);

		const raw = readFileSync(path, "utf8");
		expect(raw).toContain("\n\t");
	});
});

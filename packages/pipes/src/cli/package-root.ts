import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Walks upward from `startDir` looking for this package's own package.json
 * (matched by name, not just presence -- a consumer's own package.json could
 * sit above an installed copy). Bounded to `maxLevels` so a misconfigured
 * install fails fast instead of walking to filesystem root.
 */
export function packageRoot(startDir: string, packageName = "@danypops/pipes", maxLevels = 8): string {
	let dir = startDir;
	for (let i = 0; i < maxLevels; i++) {
		const candidate = join(dir, "package.json");
		if (existsSync(candidate)) {
			try {
				const manifest = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string };
				if (manifest.name === packageName) return dir;
			} catch {
				// fall through and keep walking -- an unrelated/unparsable package.json
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(`could not locate package root for "${packageName}" above ${startDir}`);
}

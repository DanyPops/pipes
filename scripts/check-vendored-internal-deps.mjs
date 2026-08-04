#!/usr/bin/env node
/**
 * Fails if any @danypops/* package resolves to more than one version in
 * bun.lock -- an internal package silently vendored at a stale version
 * inside another published @danypops package's own dependency pin.
 *
 * Real incident: pi-pipes' vehicle/pipes-vehicle bug (ci.wait's 30s
 * deadline clamp) was masked for a while because @danypops/vehicle-server
 * was resolving to three different versions at once (0.17.1 top-level,
 * plus 0.13.0/0.14.2 nested under @danypops/vehicle-client and
 * @danypops/vehicle-client-pi's own stale pins) -- the actual, current
 * framework code was never what got exercised.
 *
 * Deliberately scoped to @danypops/* only: the wider dependency graph
 * churns constantly from unrelated upstream releases (aws-sdk, eslint,
 * semver, ...) and isn't ours to keep converged on every PR. Our own
 * packages have no excuse -- every intermediate @danypops package's pin
 * should track the version it was actually built and released against.
 *
 * Parses bun.lock's own package tuples directly instead of shelling out to
 * bunlock-dedupe: that tool's --all/--update output re-resolves against the
 * live npm registry and visibly shifted between two manual runs minutes
 * apart during development of this check, purely from unrelated packages
 * publishing in between. A CI gate needs to read what's actually locked,
 * not a live view of what could be locked differently right now.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const lockPath = resolve(process.argv[2] ?? "bun.lock");
const text = readFileSync(lockPath, "utf-8");

// Matches every `"<key>": ["<name>@<version>", ...]` package tuple line, scoped or not.
const TUPLE_RE = /"[^"]*":\s*\["((?:@[^/"]+\/)?[^"@]+)@([^"]+)"/g;

/** @type {Map<string, Map<string, Set<string>>>} package name -> version -> set of lockfile keys resolving to it */
const versionsByPackage = new Map();

for (const match of text.matchAll(TUPLE_RE)) {
	const [, name, version] = match;
	if (!name.startsWith("@danypops/")) continue;
	let versions = versionsByPackage.get(name);
	if (!versions) versionsByPackage.set(name, (versions = new Map()));
	if (!versions.has(version)) versions.set(version, new Set());
}

// Re-scan to attach each resolved version back to the lockfile key(s) that reference it, for a
// remediation-friendly report (which nested path pinned the stale version).
const KEY_TUPLE_RE = /"([^"]*)":\s*\["((?:@[^/"]+\/)?[^"@]+)@([^"]+)"/g;
for (const match of text.matchAll(KEY_TUPLE_RE)) {
	const [, key, name, version] = match;
	const versions = versionsByPackage.get(name);
	if (!versions) continue;
	versions.get(version)?.add(key || "(root)");
}

const offenders = [...versionsByPackage.entries()].filter(([, versions]) => versions.size > 1);

if (offenders.length === 0) {
	console.log("check-vendored-internal-deps: every @danypops/* package resolves to exactly one version.");
	process.exit(0);
}

console.error(`check-vendored-internal-deps: ${offenders.length} @danypops/* package(s) resolve to more than one version in ${lockPath}:\n`);
for (const [name, versions] of offenders) {
	console.error(`${name}:`);
	for (const [version, keys] of [...versions.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		console.error(`  ${version}`);
		for (const key of [...keys].sort()) console.error(`    - ${key}`);
	}
	console.error("");
}
console.error(
	"Fix: bump the stale pin in whichever intermediate @danypops package is listed above to a version " +
		"range that includes the others, publish it, then `bun install`. If the ranges are genuinely " +
		"compatible and this is just an unmerged lockfile entry, `bunx bunlock-dedupe --fix` may resolve it.",
);
process.exit(1);

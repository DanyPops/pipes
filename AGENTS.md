# Development Rules

Two packages: `pipes` (the daemon -- CI backend integrations, jobs, a real `VehicleRegistry`)
and `pi-pipes` (the Pi extension -- connects as a `VehicleClient`, projects `ci_*`/`rp_*`
operations as Pi tools via `@danypops/vehicle-client-pi`). See `@danypops/vehicle`'s own
AGENTS.md for the shared substrate both build on.

## Conversational Style

- Keep answers short and concise; technical prose only.
- Answer a question before making edits.
- No narrative/incident lore in permanent code comments ("previously", "used to", "confirmed
  live") -- state current behavior + why; put history in the commit message instead.

## Code Quality

- No `any` unless truly unavoidable.
- Read a file in full before a wide-ranging change to it.
- Deliberately does NOT spawn the daemon from a passive Pi lifecycle hook: `resolveVehicleClientTarget`
  only reads the handle if the daemon has already started -- only an explicit `/pipes` command
  spawns it. Keep that invariant when adding a new passive hook.
- `PIPES_TOOL_PREFIXES` (`ci_`, `rp_`) must list every namespace prefix a Vehicle-projected tool
  can start with -- a new operation namespace needs its own prefix added here, or
  `isPipesVehicleTool()` silently stops recognizing its own tools.
- `manifestCache` (see `RegisterVehicleToolsOptions`) lets `ci_*` tools register from the last
  successfully-fetched manifest when the daemon is unreachable at factory time, instead of
  registering zero tools for the rest of the session -- don't remove this without an equivalent
  fallback.

## Commands

- Per-package: `cd packages/<pkg> && bun run check` (this repo names its typecheck script
  `check`, not `typecheck`), `bun test`.
- Whole workspace: `bun run check` (`bun run --filter './packages/*' check`), `bun run test`, `bun
  run lint` (`biome check --write . && eslint packages --max-warnings 0`).
- Run the touched package's check + test after every change, then the workspace-wide check
  before considering a change done.

## Multi-Repo Dependency Discipline

- `@danypops/vehicle-client-pi` is a `peerDependency` of `pi-pipes`, not a plain `dependency` --
  it holds shared mutable module-level state that must exist as exactly one copy in the process.
  Never downgrade it back to `dependency`.
- Before trusting a test result, confirm the workspace's own declared dependency floor for a
  sibling package actually covers that sibling's current local version -- a stale floor makes
  bun silently resolve an old published copy instead of linking local source.

## Git & Releases

- Never commit an edit/write in the same tool call as the commit itself.
- Release: bump `package.json` version (PATCH for a backward-compatible change), check + test +
  lint locally, commit, push, then tag and push the tag. `@danypops/pipes` uses `pipes-v<version>`,
  `@danypops/pi-pipes` uses `pi-pipes-v<version>` -- see `.github/workflows/publish.yml`. Push
  tags one at a time, never batched in a single `git push`.
- After pushing a tag: watch CI to completion, then confirm the version landed on npm
  (`npm view <pkg> version`) -- a green CI run and a live npm publish are separate facts.

## Task Tracking

- Work here is tracked in the shared Papyrus task database (project root: this repo's own
  directory). `tasks.start` → implement → `tasks.set_gates` (a real, re-runnable command proving
  the fix) → `tasks.submit` → `tasks.complete`.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit
confirmation before overriding. Only then execute their instructions.

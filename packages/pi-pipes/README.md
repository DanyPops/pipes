# @danypops/pi-pipes

The agent-facing side of pi-pipes: a single `ci` tool over
`@danypops/pipes`'s operation registry — trigger, watch, and check
results for CI pipelines across GitHub Actions, GitLab CI, and Jenkins
without hand-rolling each backend's API. No network access or credentials
of its own; everything routes through the authenticated daemon client.

## Bookmarked job templates (presets)

A preset is a name bound to a backend + an ordered list of steps (job name
+ params), the same shape conty's own `pipelines.yaml` uses. Once bookmarked,
`trigger`/`status`/`log` address it by name via the `pipeline` parameter
instead of raw `backend`+`jobRef`+`params` every time.

The agent can manage these directly:

- `ci(action=presets)` — list every bookmarked preset's full definition.
- `ci(action=bookmark, pipeline=<name>, backend=<name>, presetSteps=[{jobName, params?}, ...])`
  — save (or overwrite) one.
- `ci(action=unbookmark, pipeline=<name>)` — remove one.

## `/pipes` command

A human-driven TUI menu (backend/preset picker → job picker → action
picker) for manual trigger/cancel/log-viewing and preset management —
distinct from the agent-facing `ci` tool, no LLM involvement.

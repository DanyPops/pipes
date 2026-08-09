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
- `ci(action=trigger, pipeline=<name>, params={...})` — trigger a bookmark with a
  per-invocation override, merged onto every step's own baked-in params (the
  override wins on key collision). Use this for a preset whose values
  legitimately change between runs (a release image, a branch) instead of
  re-bookmarking it just to update one value.

## `/pipes` command

A human-driven TUI menu (backend/preset picker → job picker → action
picker) for manual trigger/cancel/log-viewing and preset management —
distinct from the agent-facing `ci` tool, no LLM involvement.

## Progress-bar visual

Live `ci_wait` updates include a responsive progress bar. Set
`PIPES_PROGRESS_BAR_STYLE` to `blocks` (default, bordered `■` cells), `smooth`
(bordered fractional block cells), `shade` (`█`/`░`), or `ascii` (`#`/`-`).
This changes only human TUI rendering; progress calculation and model-facing
Vehicle output remain unchanged.

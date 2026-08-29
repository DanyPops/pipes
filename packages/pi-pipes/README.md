# @danypops/pi-pipes

The agent-facing side of pi-pipes: one real Pi tool per operation over
`@danypops/pipes`'s registry — `ci_status`, `ci_trigger`, `ci_wait`,
`ci_subscribe`, `ci_log`, and friends — to trigger, watch, and check results
for CI pipelines across GitHub Actions, GitLab CI, and Jenkins without
hand-rolling each backend's API. No network access or credentials of its
own; everything routes through the authenticated daemon client.

```bash
pi install npm:@danypops/pi-pipes
```

## Tools

- **`ci_status`** / **`ci_log`** / **`ci_search`** — a run's verdict (with
  classified failure context), raw log text, or history search.
- **`ci_trigger`** / **`ci_wait`** / **`ci_cancel`** / **`ci_rerun`** —
  start, resolve, watch, cancel, or rerun an exact run.
- **`ci_subscribe`** / **`ci_unsubscribe`** / **`ci_tail`** — background
  watch a job; a subscribed run shows on the persistent Jobs TUI widget,
  auto-unsubscribes once terminal, and wakes the agent with its exact terminal
  status through authenticated push delivery or bounded polling fallback.
- **`ci_stages`** / **`ci_chain`** / **`ci_downstream`** — a run's
  stage/step breakdown, and downstream pipeline/artifact trees.
- **`ci_artifacts`** / **`ci_artifact_entries`** /
  **`ci_artifact_text`** / **`ci_artifact_get`** — list bounded evidence,
  inspect ZIP entries, extract UTF-8 reports, or retrieve a small artifact.
- **`ci_discover`** — lists an account-scoped GitHub backend's real repos
  (or a repo's workflow files), or a Jenkins instance's job tree — the way
  to get a real `jobRef` instead of guessing one.
- **`ci_help`** — configured backends and bookmarked presets.

## Bookmarked pipeline presets

A preset is a name bound to a backend and an ordered list of steps (job
name + params). Once saved, `ci_trigger`/`ci_status`/`ci_log` address it by
name via `pipeline` instead of raw `backend`/`jobRef`/`params` every time.

- `ci_presets_list` — every bookmarked preset's full definition.
- `ci_presets_set(name, backend, steps)` — save or overwrite one.
- `ci_presets_remove(name)` — remove one.
- `ci_trigger(pipeline, params)` — trigger a bookmark with a per-invocation
  override, merged onto each step's own baked-in params (the override wins
  on key collision) — for a preset whose values legitimately change between
  runs (a release image, a branch) instead of re-bookmarking it.

## `/pipes` command

A human-driven TUI menu (backend/preset picker → job picker → action
picker) for manual trigger/cancel/log-viewing and preset management —
distinct from the agent-facing `ci_*` tools, no LLM involvement.

## Progress-bar visual

Live `ci_wait` updates and the Jobs widget include a responsive progress
bar, rendered as a real aligned table when more than one job is
subscribed. Set `PIPES_PROGRESS_BAR_STYLE` to `blocks` (default, bordered
`■` cells), `smooth` (bordered fractional block cells), `shade`
(`█`/`░`), or `ascii` (`#`/`-`). This changes only human TUI rendering;
progress calculation and model-facing tool output remain unchanged.

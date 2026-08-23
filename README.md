# pi-pipes

A Pi extension and daemon for cross-platform CI: GitHub Actions, GitLab CI,
and Jenkins, from one agent-facing `ci` tool set, without hand-rolling each
backend's API.

## Packages

- **[`packages/pipes`](packages/pipes/README.md)** — `@danypops/pipes`, the
  supervised daemon: CI credentials, backend adapters, orchestration, and a
  local run-history pool (status + logs).
- **[`packages/pi-pipes`](packages/pi-pipes/README.md)** — `@danypops/pi-pipes`,
  the Pi extension: one real tool per operation (`ci_status`, `ci_trigger`,
  `ci_subscribe`, ...), an authenticated daemon client, no direct
  network/credential access of its own.

## Architecture

```text
Pi ci_* tools                           (packages/pi-pipes)
      ↓
authenticated loopback client
      ↓
Pipes daemon: auth, dispatch, run pool  (packages/pipes)
      ↓
backend adapters: GitHub Actions, GitLab CI, Jenkins, Report Portal
      ↓
local SQLite pool (run status + cached logs)
```

## Status

Real GitHub/GitLab/Jenkins adapters, orchestration with named pipeline
presets, background job subscriptions with a persistent Jobs TUI widget, and
the npm publish pipeline are all live. Outstanding: typed per-operation CLI
subcommands and their own parity tests — today's CLI reaches every operation
through one generic, typed `pipes call <op> [json]` passthrough (see
`packages/pipes/README.md`) rather than a dedicated subcommand per
operation.

## Development

```bash
npm install
npm run check   # tsc --noEmit across every package
npm test        # bun test across every package
```

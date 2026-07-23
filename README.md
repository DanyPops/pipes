# pi-pipes

A pi extension and daemon for cross-platform CI: GitHub Actions, GitLab CI,
and Jenkins, from one agent-facing `ci` tool, without hand-rolling each
backend's API.

## Status

Core is implemented: real GitHub, GitLab, and Jenkins adapters (OAuth device
flow for GitHub, OAuth2 device flow/PKCE for GitLab, API-token auth for
Jenkins — the one backend with no delegated-auth API), an orchestration
layer with named pipeline presets, and a supervised daemon that composes
them with a local SQLite pool of run status and cached logs. The agent-facing
`ci` tool supports triggering, blocking waits, status/log/search, job-level
subscribe/unsubscribe with autofocus onto a job's latest run, token-budgeted
log tailing, and a bounded chain/artifact crawler for backends that expose
downstream-pipeline data (GitLab; Jenkins via an explicit job-name lookup).

Remaining: a TUI menu for preset management and manual intervention
(secondary to the `ci` tool), end-to-end CLI parity, and the npm publish
workflow.

## Layout

```text
packages/pipes-daemon/    supervised daemon: owns CI credentials, backend
                          adapters, orchestration, and a local run-history
                          pool (status + logs)
packages/pi-extension/    pi extension: the agent-facing `ci` tool, an
                          authenticated daemon client, no direct
                          network/credential access
```

## Development

```bash
npm install
npm run check   # tsc --noEmit across every package
npm test        # bun test across every package
```

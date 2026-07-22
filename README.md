# pi-pipes

A pi extension for cross-platform CI: GitHub Actions, GitLab CI, Jenkins, and
Prow, from one TUI menu.

## Status

Early scaffold. The workspace layout and package boundaries exist; backend
adapters (GitHub/GitLab/Jenkins/Prow) and the daemon composition are not
implemented yet. This README will grow an architecture diagram and full
CLI/operation reference as those land — see `packages/pipes-daemon` and
`packages/pi-extension` for current package-level status.

## Layout

```text
packages/pipes-daemon/    supervised daemon: owns CI credentials, backend
                          adapters, and a local run-history cache
packages/pi-extension/    thin pi extension: authenticated daemon client +
                          TUI menu, no direct network/credential access
```

## Development

```bash
npm install
npm run check   # tsc --noEmit across every package
npm test        # bun test / vitest across every package
```

# @danypops/pi-pipes

The agent-facing side of pi-pipes: a single `ci` tool over
`@danypops/pipes`'s operation registry — trigger, watch, and check
results for CI pipelines across GitHub Actions, GitLab CI, and Jenkins
without hand-rolling each backend's API. No network access or credentials
of its own; everything routes through the authenticated daemon client.

Also registers a `/pipes` command (`ci.help`) to inspect configured
backends and presets from the terminal.

A TUI menu for preset management and manual intervention is planned as a
secondary surface — the `ci` tool is the primary one.

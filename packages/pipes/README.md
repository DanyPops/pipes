# @danypops/pipes

Supervised Bun daemon (built on `@danypops/daemon-kit`) that owns CI
credentials, real GitHub Actions/GitLab CI/Jenkins adapters, an
orchestration layer with named pipeline presets, and a local SQLite pool of
run status and cached logs — the standalone-adapter shape: the pool syncs on
its own schedule regardless of whether any client is connected.

## Operations

Exposed over an authenticated loopback HTTP API (`POST /api/v1/ops`), and
callable via the CLI's generic passthrough (`pipes call <op> [json]`):

- `ci.help` — configured backends and registered presets
- `ci.status` / `ci.log` / `ci.search` — live backend reads, with grep/tail
  filtering and classified-failure context on the compact status verdict
- `ci.trigger` / `ci.wait` / `ci.cancel` — trigger a raw job or a named
  preset, block until terminal, session-ownership-gated cancel
- `ci.subscribe` / `ci.unsubscribe` / `ci.pool` / `ci.tail` — job-level
  background watching (autofocuses on a job's latest run, auto-unsubscribes
  once it finishes) with cheap, pool-only reads and token-budgeted log tails
- `ci.stages` / `ci.chain` / `ci.downstream` — pipeline stage/step trees, a
  bounded (cycle-safe, node-capped) downstream/artifact tree, and a targeted
  downstream lookup for backends that need an explicit job name (Jenkins)

## Auth

Real delegated auth wherever the backend has one: GitHub OAuth Device
Authorization Grant, GitLab OAuth2 Device Flow (or Authorization Code+PKCE
via a local loopback listener on older instances). Jenkins has no delegated
auth API, so it uses a stored username+API-token pair — the one documented
exception, not a default.

## Multiple repos/projects per backend

`GITHUB_OWNER`/`GITHUB_REPO` (and `GITLAB_URL`/`GITLAB_PROJECT_ID`) configure
one default GitHub/GitLab backend, both named after the backend type. To
address more than one repo or project through the same daemon, add a
`~/.config/pipes/repos.json` (or `$XDG_CONFIG_HOME/pipes/repos.json`)
naming each target explicitly — once this file has entries for a backend
type, it replaces that type's env-var default rather than adding to it:

```json
{
	"github": [
		{ "name": "github-lector", "owner": "DanyPops", "repo": "lector" },
		{ "name": "github-packed", "owner": "DanyPops", "repo": "pi-packed" }
	],
	"gitlab": [{ "name": "gitlab-infra", "projectId": "42" }]
}
```

Every GitHub target shares the one logged-in GitHub credential (a device-flow
token authenticates any repo the granting user can access); every GitLab
target shares one credential too, so all configured GitLab targets must be
on the same GitLab host. `ci(action=help)` lists each configured target by
its own name — pass that name as `backend` to address it.

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

`pipes login <github|gitlab|jenkins> [--as <profile>]` runs the flow and
stores the result — omit `--as` to use the plain default credential, or
name a profile to keep a second account/server separate (see "Multiple
repos/projects per backend" below). Every device-flow and PKCE login prints
the verification URL/code as text regardless, and also best-effort opens it
in your default browser (matching GitHub CLI's own UX) — a headless
session or missing browser opener never blocks the login, it just falls
back to the printed URL.

### GitHub: reuse an already-authenticated `gh` CLI session

`pipes login github --gh-cli [account]` skips the OAuth device flow (and
the `GITHUB_CLIENT_ID` App registration it needs) entirely by reading
`gh auth token` instead — the same delegation pattern packed uses for
`npm login --auth-type=web`: never re-implement a vendor CLI's own auth,
just consume its result. Works whether `gh` stores its token in the OS
keyring or a legacy plaintext file, since `gh auth token` is GitHub's own
stable interface for exactly this, abstracting over both. Omit `account`
for `gh`'s current active account, or name one of `gh`'s own multiple
authenticated accounts (`gh auth status` lists them) — pairs naturally
with `--as` to register each as its own pipes profile:

```bash
pipes login github --gh-cli DanyPops --as personal
pipes login github --gh-cli work-account --as work
```

```bash
GITHUB_CLIENT_ID=<client-id> pipes login github --as personal
GITHUB_CLIENT_ID=<client-id> pipes login github --as work
GITLAB_CLIENT_ID=<client-id> pipes login gitlab
JENKINS_URL=<url> JENKINS_USER=<user> JENKINS_API_TOKEN=<token> pipes login jenkins --as ci
```

### Optional: credentials via Enigma

If a [Enigma](https://github.com/DanyPops/enigma) vault is running, pipes
checks it first on every request, ahead of its own stored token and any
static `*_TOKEN` env var — a credential Enigma rotates is picked up on the
very next call, no daemon restart needed. Purely additive: pipes works
identically with no Enigma running at all.

Register pipes as a scoped Enigma client (once), then pass the printed
token to the daemon via `ENIGMA_CLIENT_TOKEN`:

```bash
enigma client add pipes --backends github,gitlab,jenkins
# -> prints a token once; export it wherever the pipes daemon is started
export ENIGMA_CLIENT_TOKEN=<printed token>
```

Without `ENIGMA_CLIENT_TOKEN`, pipes falls back to Enigma's shared
admin-token file if one exists at `$XDG_STATE_HOME/enigma/token` — fine for
a single-user machine where every local daemon is equally trusted, but a
scoped client token is the least-privilege default.

## Multiple repos/projects/servers per backend

`GITHUB_OWNER`/`GITHUB_REPO`, `GITLAB_URL`/`GITLAB_PROJECT_ID`, and
`JENKINS_URL`/`JENKINS_USER`/`JENKINS_API_TOKEN` each configure one default
backend, named after the backend type. To address more than one repo,
project, or Jenkins server through the same daemon, add a
`~/.config/pipes/repos.json` (or `$XDG_CONFIG_HOME/pipes/repos.json`)
naming each target explicitly — once this file has entries for a backend
type, it replaces that type's env-var default rather than adding to it:

```json
{
	"github": [
		{ "name": "github-a", "owner": "octocat", "repo": "repo-a" },
		{ "name": "github-b", "owner": "octocat", "repo": "repo-b", "profile": "work" }
	],
	"gitlab": [{ "name": "gitlab-a", "projectId": "42" }],
	"jenkins": [
		{ "name": "jenkins-ci", "baseUrl": "https://ci.example.com" },
		{ "name": "jenkins-auto", "baseUrl": "https://auto.example.com" }
	]
}
```

Every GitHub target shares one logged-in GitHub credential by default (a
device-flow token authenticates any repo the granting user can access);
every GitLab target likewise shares one credential, so every configured
GitLab target must be on the same GitLab host. A target's optional
`profile` field selects a separate, named local credential file instead of
sharing the default (`pipes login <backend> --as <profile>` writes to it) —
use this for a second GitHub/GitLab account. Jenkins targets are the
exception: since a Jenkins API token is inherently scoped to one specific
server+user, each target's profile defaults to its own `name` already, so
two Jenkins servers never collide without needing an explicit `profile`.

`ci(action=help)` lists each configured target by its own name — pass that
name as `backend` to address it.

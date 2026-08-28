# @danypops/pipes

Supervised Bun daemon (built on `@danypops/vehicle-server`) that owns CI
credentials, real GitHub Actions/GitLab CI/Jenkins adapters, an
orchestration layer with named pipeline presets, and a local SQLite pool of
run status and cached logs — the standalone-adapter shape: the pool syncs on
its own schedule regardless of whether any client is connected. It also owns
a Report Portal launch/test-item query adapter (`rp.*`) — a separate
LaunchBackend port, not a CIBackend: test-execution results are a different
domain than CI runs, and there's exactly one Report Portal instance to talk
to rather than a multi-adapter registry.

## Service (systemd --user)

```bash
pipes service install   # write a systemd user unit, enable, and start it
pipes service status
pipes service restart
pipes service stop
```

`pipes serve` also works as a one-off foreground run. The daemon enforces a
single-instance lock either way, so an ad hoc `serve` and the installed
service can never both hold the port at once.

## Operations

Exposed over an authenticated loopback HTTP API (`POST /api/v1/ops`), and
callable via the CLI's generic passthrough (`pipes call <op> [json]`):

- `ci.help` — configured backends and registered presets
- `ci.status` / `ci.log` / `ci.search` — live backend reads, with grep/tail
  filtering and classified-failure context on the compact status verdict
- `ci.trigger` / `ci.wait` / `ci.cancel` / `ci.rerun` — trigger a raw job or
  named preset, resolve and watch its exact run, cancel owned runs, or rerun all
  or failed jobs where supported
- `ci.subscribe` / `ci.unsubscribe` / `ci.pool` / `ci.tail` — job-level
  background watching (autofocuses on a job's latest run, auto-unsubscribes
  once it finishes) with cheap, pool-only reads and token-budgeted log tails
- `ci.stages` / `ci.chain` / `ci.downstream` — pipeline stage/step trees, a
  bounded (cycle-safe, node-capped) downstream/artifact tree, and a targeted
  downstream lookup for backends that need an explicit job name (Jenkins)
- `ci.artifacts` / `ci.artifact.entries` / `ci.artifact.text` /
  `ci.artifact.get` — bounded artifact metadata, safe ZIP entry discovery,
  UTF-8 evidence extraction, and small base64 downloads
- `rp.launches` / `rp.launch` / `rp.items` / `rp.search` / `rp.item` /
  `rp.items.get` — Report Portal launch and test-item queries. `rp.search`
  is cross-launch and requires `launchIds` — resolve a launch name/date range
  to ids via `rp.launches` first, since Report Portal's own `/item` endpoint
  400s without at least one launch id.
- `rp.defects.update` — bulk defect classification (issue type, comment,
  linked tickets) on one or more test items, a real write
- `rp.dashboards` / `rp.dashboard` / `rp.dashboard.create` /
  `rp.dashboard.widget.add` — Report Portal dashboard CRUD

## Auth

Real delegated auth wherever the backend has one: GitHub OAuth Device
Authorization Grant, GitLab OAuth2 Device Flow (or Authorization Code+PKCE
via a local loopback listener on older instances). Jenkins and Report Portal
have no delegated auth API, so each uses a stored static credential — the
documented exception for those two backends, not a default.

`pipes login <github|gitlab|jenkins|reportportal> [--as <profile>]` runs the
flow and stores the result — omit `--as` to use the plain default
credential, or name a profile to keep a second account/server separate (see
"Multiple repos/projects per backend" below; Report Portal itself doesn't
support a profile yet, since there's only ever one configured instance).
Report Portal reads `RP_URL`/`RP_PROJECT`/`RP_API_KEY` (also the resolution
order's env-var step, and the names Enigma's own Report Portal credential's
`extra.url`/`extra.project` fields map onto). Every device-flow and PKCE
login prints the verification URL/code as text regardless, and also
best-effort opens it in your default browser (matching GitHub CLI's own
UX) — a headless session or missing browser opener never blocks the login,
it just falls back to the printed URL.

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

With an Enigma new enough to serve its admin Unix socket (kernel-verified
peer identity, `SO_PEERCRED`), pipes tries that transport first and needs
**no token at all** for a client registered by uid (`enigma client add pipes
--backends ... --uid $(id -u)`) — nothing to generate, export, or leak.
Falls back to `ENIGMA_CLIENT_TOKEN`/the shared admin-token file unchanged
when no socket is available (older Enigma, or none running).

### The full ladder

Each backend resolves its credential in this order, every request, cheapest
and least secret-bearing first:

1. **Static env var** (`GITHUB_TOKEN`, `GITLAB_TOKEN`, `JENKINS_API_TOKEN`) — zero setup, but a plaintext secret in the process environment.
2. **A local named credential profile** — `pipes login github --as work` stores a separate credential per profile (one file per profile-qualified name, e.g. `github-work.json`), so two accounts on the same platform never collide. `pipes credentials list` / `pipes credentials remove <name>` manage what's stored, without ever printing a stored credential's contents. A `repos.json` target opts into one via its own `profile` field.
3. **Enigma, if running** — checked first, ahead of both of the above, via a scoped client token or (when available) the zero-secret Unix-socket transport described above.

Each rung is opt-in: skipping straight to env vars, or never running Enigma at all, works identically to always having used it.

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
		{ "name": "acme-github", "owner": "acme-corp", "profile": "work" }
	],
	"gitlab": [{ "name": "gitlab-a", "projectId": "42" }],
	"jenkins": [
		{ "name": "jenkins-ci", "baseUrl": "https://ci.example.com" },
		{ "name": "jenkins-auto", "baseUrl": "https://auto.example.com" }
	]
}
```

A GitHub target's `repo` field is optional. Given (`github-a` above), the
backend is pinned to that one repo and `jobRef` stays a bare workflow file
name (`"publish.yml"`), unchanged from a single-repo setup. Omitted
(`acme-github` above), the backend is account-scoped: it covers every repo
under `owner`, and `jobRef` must instead be `"repo/workflow.yml"` (e.g.
`"widgets/ci.yml"`) — the repo is resolved fresh on every call, not fixed
at startup. A bare workflow name against an account-scoped backend fails
loudly rather than guessing which repo you meant.

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

`ci_help` lists each configured target by its own name — pass that name as
`backend` to address it.

## Discovering what's under an account-scoped backend

An account-scoped GitHub backend hides which repos are actually valid --
`ci_discover(backend=...)` lists every repo the credential can see under
that backend's owner (bounded to the first 100), and
`ci_discover(backend=..., repo=...)` lists that repo's workflow files by
their real file names -- the exact strings valid as `jobRef`'s second half.

Jenkins has no repo/workflow split, but the same operation is implemented
against its own job-tree shape: `ci_discover(backend=...)` lists the
instance's top-level jobs and folders, and `ci_discover(backend=...,
repo=<folder>)` lists that folder's child jobs/folders one level down.
Each returned workflow's `fileName` is already a real, folder-nested
`jobRef` valid everywhere else in this tool -- pass `repo` as a leaf job
(not a folder) and it comes back as its own single workflow, so discovery
composes down to an exact, immediately-usable jobRef without ever having
to guess Jenkins' `job/foo/job/bar` path encoding by hand.

Not implemented for GitLab yet; `ci_discover` against it fails with a
clear "capability not supported" error rather than a crash.

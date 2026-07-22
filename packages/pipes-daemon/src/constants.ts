/** XDG state-directory name shared by paths.ts (daemon side) and the
 * pi-extension's duplicated client (see pi-extension/src/daemon-client.ts
 * for why it's a duplicate, not an import). Keep these two in sync by hand. */
export const STATE_DIRECTORY_NAME = "pipes";
export const DATABASE_FILENAME = "pipes.db";
export const TOKEN_FILENAME = "auth-token";
export const HANDLE_FILENAME = "daemon.json";
export const SYSTEMD_UNIT_NAME = "pipes.service";

/** Filenames for per-backend credential files, stored alongside auth-token in the same XDG_STATE_HOME/pipes directory. */
export const GITHUB_TOKEN_FILENAME = "github-token.json";
export const GITLAB_TOKEN_FILENAME = "gitlab-token.json";
export const JENKINS_CREDENTIALS_FILENAME = "jenkins-credentials.json";

/** Matches conty's differentiated cache TTL for live status polling (see the ported gotchas doc). */
export const RUN_POOL_SYNC_INTERVAL_MS = 30_000;

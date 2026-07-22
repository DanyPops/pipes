/** XDG state-directory name shared by paths.ts (daemon side) and the
 * pi-extension's duplicated client (see pi-extension/src/daemon-client.ts
 * for why it's a duplicate, not an import). Keep these two in sync by hand. */
export const STATE_DIRECTORY_NAME = "pipes";
export const DATABASE_FILENAME = "pipes.db";
export const TOKEN_FILENAME = "auth-token";
export const HANDLE_FILENAME = "daemon.json";
export const SYSTEMD_UNIT_NAME = "pipes.service";

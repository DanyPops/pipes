import { dirname } from "node:path";
import { type DaemonPaths, type PathEnvironment, resolveDaemonPaths } from "@danypops/vehicle-server/paths";
import { DATABASE_FILENAME, HANDLE_FILENAME, STATE_DIRECTORY_NAME, SYSTEMD_UNIT_NAME, TOKEN_FILENAME } from "./constants.ts";

export function resolvePipesPaths(options: PathEnvironment = {}): DaemonPaths {
	return resolveDaemonPaths(
		{
			stateDirectoryName: STATE_DIRECTORY_NAME,
			databaseFilename: DATABASE_FILENAME,
			tokenFilename: TOKEN_FILENAME,
			handleFilename: HANDLE_FILENAME,
			systemdUnitName: SYSTEMD_UNIT_NAME,
		},
		options,
	);
}

/** One directory, shared by every backend's vehicle-server vault.ts file store -- each backend picks its own filename via profiledBackend(). */
export interface PipesCredentialPaths {
	credentialsDir: string;
}

/** Credential files live next to auth-token in the same XDG_STATE_HOME/pipes directory, not under a separate root. */
export function resolvePipesCredentialPaths(paths: DaemonPaths): PipesCredentialPaths {
	return { credentialsDir: dirname(paths.token) };
}

/**
 * Profile-qualifies a backend name for vehicle-server's createFileStore/createEncryptedFileStore
 * keying (e.g. "github" -> github.json, "github-work" -> github-work.json) -- the local
 * named-credential-profile tier: omitted resolves the plain backend name unchanged (a target
 * that never opts into profiles sees zero behavior change), a named profile resolves its own
 * separate file so two targets of the same backend type (two GitHub accounts, two Jenkins
 * servers) can hold genuinely different credentials instead of being forced to share the one
 * file every target used to share.
 */
export function profiledBackend(backend: string, profile?: string): string {
	return profile ? `${backend}-${profile}` : backend;
}

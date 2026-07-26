import { dirname, join } from "node:path";
import { type DaemonPaths, type PathEnvironment, resolveDaemonPaths } from "@danypops/daemon-kit/paths";
import {
	DATABASE_FILENAME,
	GITHUB_TOKEN_FILENAME,
	GITLAB_TOKEN_FILENAME,
	HANDLE_FILENAME,
	JENKINS_CREDENTIALS_FILENAME,
	STATE_DIRECTORY_NAME,
	SYSTEMD_UNIT_NAME,
	TOKEN_FILENAME,
} from "./constants.ts";

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

export interface PipesCredentialPaths {
	githubToken: string;
	gitlabToken: string;
	jenkinsCredentials: string;
}

/** Credential files live next to auth-token in the same XDG_STATE_HOME/pipes directory, not under a separate root. */
export function resolvePipesCredentialPaths(paths: DaemonPaths): PipesCredentialPaths {
	const stateDirectory = dirname(paths.token);
	return {
		githubToken: join(stateDirectory, GITHUB_TOKEN_FILENAME),
		gitlabToken: join(stateDirectory, GITLAB_TOKEN_FILENAME),
		jenkinsCredentials: join(stateDirectory, JENKINS_CREDENTIALS_FILENAME),
	};
}

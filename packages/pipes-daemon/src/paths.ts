import { type DaemonPaths, type PathEnvironment, resolveDaemonPaths } from "@danypops/daemon-kit/paths";
import {
	DATABASE_FILENAME,
	HANDLE_FILENAME,
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

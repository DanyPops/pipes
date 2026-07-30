/**
 * Builds pipes' own SecretsBackend set for vehicle-client-pi's generic /secrets
 * menu: the local credential-profile directory every `pipes login` writes
 * to (github/gitlab/jenkins profiles, including the gh-CLI-sourced ones),
 * plus the two static-token env vars pipes' adapters fall back to.
 *
 * Deliberately reuses resolvePipesPaths() from daemon-client.ts, itself a
 * duplicate of @danypops/pipes's own paths.ts by design (see that file's
 * header) -- this module inherits the same "no raw-source import across
 * the Node/tsc boundary" constraint, not a new one.
 *
 * Not registered as its own top-level `/secrets` Pi command: pi-enigma
 * already owns that command name, and Pi has no per-extension command
 * namespacing -- two extensions registering the same name would collide.
 * Exposed instead as a "Secrets" entry inside pipes' own `/pipes` menu.
 */
import { dirname } from "node:path";
import { createEnvSecretsBackend } from "@danypops/vehicle-client-pi/secrets-backend-env";
import { createLocalSecretsBackend } from "@danypops/vehicle-client-pi/secrets-backend-local";
import type { SecretsBackend } from "@danypops/vehicle-client-pi/secrets-backend";
import { resolvePipesPaths } from "./daemon-client.ts";

export interface BuildPipesSecretsBackendsOptions {
	env?: Record<string, string | undefined>;
	home?: string;
	uid?: number;
}

export function buildPipesSecretsBackends(options: BuildPipesSecretsBackendsOptions = {}): SecretsBackend[] {
	const env = options.env ?? process.env;
	const credentialsDir = dirname(resolvePipesPaths({ env, home: options.home, uid: options.uid }).token);
	return [createLocalSecretsBackend({ dir: credentialsDir }), createEnvSecretsBackend({ github: "GITHUB_TOKEN", gitlab: "GITLAB_TOKEN" }, env)];
}

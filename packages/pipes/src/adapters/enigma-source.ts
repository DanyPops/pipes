/**
 * Optional credential source: a running Enigma vault (github.com/DanyPops/enigma),
 * if one happens to be configured on this machine. Purely additive -- Pipes
 * has never imported Enigma's package and never will; this talks to Enigma's
 * loopback HTTP API using only @danypops/daemon-kit, which Pipes already
 * depends on for its own daemon plumbing. Enigma's discovery contract is
 * three stable, documented constants (its state-directory name and its
 * handle/token filenames), not an import of Enigma's own source.
 *
 * Never creates Enigma's handle or token files -- those are strictly
 * Enigma's own job on its first boot. Every failure path here resolves
 * undefined rather than throwing, and the whole attempt is time-bounded so
 * a slow or hung Enigma can never stall a request.
 */
import { existsSync, readFileSync } from "node:fs";
import { readDaemonHandle, resolveDaemonPaths } from "@danypops/daemon-kit/paths";
import { createVaultClient, type VaultCredential } from "@danypops/daemon-kit/vault";

const ENIGMA_STATE_DIRECTORY_NAME = "enigma";
const ENIGMA_HANDLE_FILENAME = "handle.json";
const ENIGMA_TOKEN_FILENAME = "token";
const ENIGMA_LOOKUP_TIMEOUT_MS = 500;

export interface TryEnigmaCredentialEnv {
	env?: Record<string, string | undefined>;
	/** Injectable for tests; production default is the real fetch, bounded by AbortSignal.timeout. */
	fetchImpl?: typeof fetch;
}

export type TryEnigmaVaultCredential = (backend: string, opts?: TryEnigmaCredentialEnv) => Promise<VaultCredential | undefined>;
export type TryEnigmaCredential = (backend: string, opts?: TryEnigmaCredentialEnv) => Promise<string | undefined>;

/** The full stored shape (accessToken + extra), for a backend like Jenkins whose credential is more than a bare token (url/username live in extra). */
export const tryEnigmaVaultCredential: TryEnigmaVaultCredential = async (backend, opts = {}) => {
	const env = opts.env ?? process.env;
	const paths = resolveDaemonPaths(
		{ stateDirectoryName: ENIGMA_STATE_DIRECTORY_NAME, handleFilename: ENIGMA_HANDLE_FILENAME, tokenFilename: ENIGMA_TOKEN_FILENAME, databaseFilename: "", systemdUnitName: "" },
		{ env },
	);

	const handle = readDaemonHandle(paths.handle);
	if (!handle) return undefined; // Enigma isn't running -- not an error, just not present

	if (!existsSync(paths.token)) return undefined; // never ensureAuthToken here -- read-only, never mint Enigma's own token
	let token: string;
	try {
		token = readFileSync(paths.token, "utf8").trim();
	} catch {
		return undefined;
	}

	const fetchImpl = opts.fetchImpl ?? fetch;
	const client = createVaultClient({
		baseUrl: `http://${handle.host}:${handle.port}`,
		authToken: token,
		fetchImpl: (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(ENIGMA_LOOKUP_TIMEOUT_MS) }),
	});

	try {
		return await client.getCredentials(backend);
	} catch {
		return undefined; // unreachable, timed out, or any other transport failure -- fall through silently
	}
};

/** Resolves just the access token -- what github/gitlab's adapters need, since they already resolve baseUrl/etc. separately from env. */
export const tryEnigmaCredential: TryEnigmaCredential = async (backend, opts = {}) => (await tryEnigmaVaultCredential(backend, opts))?.accessToken;

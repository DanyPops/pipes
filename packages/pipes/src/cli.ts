#!/usr/bin/env bun
import { createGitHubTokenStore, runDeviceFlow as runGitHubDeviceFlow } from "./adapters/github/auth.ts";
import { authenticate as authenticateGitLab, createGitLabTokenStore } from "./adapters/gitlab/auth.ts";
import { createFileCredentialStore } from "./adapters/jenkins/auth.ts";
import { connectPipesClient } from "./client.ts";
import { serveMain } from "./daemon.ts";
import { profiledBackend, resolvePipesCredentialPaths, resolvePipesPaths } from "./paths.ts";

const [, , command] = process.argv;

/** Reads "--as <profile>" from a login command's trailing args, e.g. `pipes login jenkins --as auto`. */
function parseAsFlag(args: string[]): string | undefined {
	const index = args.indexOf("--as");
	return index === -1 ? undefined : args[index + 1];
}

/**
 * Runs entirely client-side against the backend's own OAuth endpoints, not
 * through the daemon's RPC — a device-flow poll can run for minutes, which
 * doesn't fit a request/response daemon call, and login must also work
 * before a daemon has ever been started. Writes land in the same credential
 * files the daemon's token provider re-reads on every request, so a running
 * daemon picks up a fresh login on its very next call, no restart needed.
 */
async function loginMain(backend: string | undefined, args: string[]): Promise<void> {
	const credentialPaths = resolvePipesCredentialPaths(resolvePipesPaths());
	const profile = parseAsFlag(args);

	if (backend === "github") {
		const clientId = process.env.GITHUB_CLIENT_ID;
		if (!clientId) {
			console.error("GITHUB_CLIENT_ID is required — register a personal OAuth App with Device Flow enabled at github.com/settings/developers");
			process.exit(1);
		}
		const token = await runGitHubDeviceFlow({
			clientId,
			scope: process.env.GITHUB_SCOPES,
			onPrompt: (info) => {
				console.log(`Visit ${info.verificationUri} and enter code: ${info.userCode}`);
				console.log("Waiting for authorization...");
			},
		});
		createGitHubTokenStore(credentialPaths.credentialsDir, profiledBackend("github", profile)).save(token);
		console.log(profile ? `GitHub login complete (stored as "${profile}").` : "GitHub login complete.");
		return;
	}

	if (backend === "gitlab") {
		const baseUrl = process.env.GITLAB_URL;
		const clientId = process.env.GITLAB_CLIENT_ID;
		if (!baseUrl || !clientId) {
			console.error("GITLAB_URL and GITLAB_CLIENT_ID are required — register a personal Application under your GitLab instance's User Settings > Applications");
			process.exit(1);
		}
		const token = await authenticateGitLab({
			baseUrl,
			clientId,
			scope: process.env.GITLAB_SCOPES,
			onDevicePrompt: (info) => {
				console.log(`Visit ${info.verificationUri} and enter code: ${info.userCode}`);
				console.log("Waiting for authorization...");
			},
			onPkcePrompt: (authorizationUrl) => {
				console.log(`Visit ${authorizationUrl} to authorize (this GitLab instance doesn't advertise device flow).`);
				console.log("Waiting for the browser redirect...");
			},
		});
		createGitLabTokenStore(credentialPaths.credentialsDir, profiledBackend("gitlab", profile)).save(token);
		console.log(profile ? `GitLab login complete (stored as "${profile}").` : "GitLab login complete.");
		return;
	}

	if (backend === "jenkins") {
		const { JENKINS_URL: url, JENKINS_USER: username, JENKINS_API_TOKEN: apiToken } = process.env;
		if (!url || !username || !apiToken) {
			console.error("JENKINS_URL, JENKINS_USER, and JENKINS_API_TOKEN are required — generate an API token from your Jenkins user's Configure page");
			process.exit(1);
		}
		// Unlike github/gitlab's profile (a suffix on a shared default identity), a Jenkins
		// profile IS the final backend name directly -- matches config.ts's own repos.json
		// wiring, where a target's stored-credential file is named after its own profile
		// (defaulting to the target's own name) with no "jenkins-" prefix added on top.
		createFileCredentialStore(credentialPaths.credentialsDir, profile ?? "jenkins").save({ baseUrl: url, username, apiToken });
		console.log(profile ? `Jenkins credentials saved (stored as "${profile}").` : "Jenkins credentials saved.");
		return;
	}

	console.error("usage: pipes login <github|gitlab|jenkins> [--as <profile>]");
	process.exit(1);
}

switch (command) {
	case "serve":
		await serveMain();
		break;
	case "login":
		await loginMain(process.argv[3], process.argv.slice(4));
		break;
	case "health": {
		const client = connectPipesClient();
		const health = await client.health();
		console.log(JSON.stringify(health));
		break;
	}
	case "backends": {
		const client = connectPipesClient();
		const { backends, pipelines } = await client.call("ci.help", {});
		console.log(JSON.stringify({ backends, pipelines }));
		break;
	}
	case "call": {
		const [, , , op, inputJson] = process.argv;
		if (!op) {
			console.error("usage: pipes call <op> [json-input]");
			process.exit(1);
		}
		const client = connectPipesClient();
		const input = inputJson ? JSON.parse(inputJson) : {};
		const result = await client.call(op as Parameters<typeof client.call>[0], input);
		console.log(JSON.stringify(result));
		break;
	}
	default:
		console.error(
			"usage: pipes <serve|login|health|backends|call>\n  login <github|gitlab|jenkins> [--as <profile>]  authenticate and store credentials for a backend\n  call <op> [json-input]         invoke any ci.* operation, e.g. call ci.pool '{\"backend\":\"gh\",\"jobRef\":\"job\"}'",
		);
		process.exit(1);
}

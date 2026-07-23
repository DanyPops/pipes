#!/usr/bin/env bun
import { createFileTokenStore as createGitHubTokenStore, runDeviceFlow as runGitHubDeviceFlow } from "./adapters/github/auth.ts";
import { authenticate as authenticateGitLab, createFileTokenStore as createGitLabTokenStore } from "./adapters/gitlab/auth.ts";
import { createFileCredentialStore } from "./adapters/jenkins/auth.ts";
import { connectPipesClient } from "./client.ts";
import { serveMain } from "./daemon.ts";
import { resolvePipesCredentialPaths, resolvePipesPaths } from "./paths.ts";

const [, , command] = process.argv;

/**
 * Runs entirely client-side against the backend's own OAuth endpoints, not
 * through the daemon's RPC — a device-flow poll can run for minutes, which
 * doesn't fit a request/response daemon call, and login must also work
 * before a daemon has ever been started. Writes land in the same credential
 * files the daemon's token provider re-reads on every request, so a running
 * daemon picks up a fresh login on its very next call, no restart needed.
 */
async function loginMain(backend: string | undefined): Promise<void> {
	const credentialPaths = resolvePipesCredentialPaths(resolvePipesPaths());

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
		createGitHubTokenStore(credentialPaths.githubToken).save(token);
		console.log("GitHub login complete.");
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
		createGitLabTokenStore(credentialPaths.gitlabToken).save(token);
		console.log("GitLab login complete.");
		return;
	}

	if (backend === "jenkins") {
		const { JENKINS_URL: url, JENKINS_USER: username, JENKINS_API_TOKEN: apiToken } = process.env;
		if (!url || !username || !apiToken) {
			console.error("JENKINS_URL, JENKINS_USER, and JENKINS_API_TOKEN are required — generate an API token from your Jenkins user's Configure page");
			process.exit(1);
		}
		createFileCredentialStore(credentialPaths.jenkinsCredentials).save({ baseUrl: url, username, apiToken });
		console.log("Jenkins credentials saved.");
		return;
	}

	console.error("usage: pipes-daemon login <github|gitlab|jenkins>");
	process.exit(1);
}

switch (command) {
	case "serve":
		serveMain();
		break;
	case "login":
		await loginMain(process.argv[3]);
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
			console.error("usage: pipes-daemon call <op> [json-input]");
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
			"usage: pipes-daemon <serve|login|health|backends|call>\n  login <github|gitlab|jenkins>  authenticate and store credentials for a backend\n  call <op> [json-input]         invoke any ci.* operation, e.g. call ci.pool '{\"backend\":\"gh\",\"jobRef\":\"job\"}'",
		);
		process.exit(1);
}

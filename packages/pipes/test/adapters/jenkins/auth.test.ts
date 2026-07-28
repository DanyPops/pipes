import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "../../../src/adapters/github/auth.ts";
import type { TryEnigmaCredential } from "@danypops/enigma-client";
import {
	basicAuthHeader,
	createCrumbCache,
	createFileCredentialStore,
	fetchCrumb,
	resolveJenkinsCredentials,
	resolveJenkinsCredentialsForBaseUrl,
	withCrumbHeaders,
} from "../../../src/adapters/jenkins/auth.ts";

const CREDENTIALS = { baseUrl: "https://jenkins.example.com", username: "alice", apiToken: "tok123" };

/**
 * Never the real tryEnigmaCredential in a test: it does a real filesystem
 * check against $XDG_RUNTIME_DIR, and a real Enigma daemon may genuinely be
 * running on the machine executing this suite -- tests must never depend on
 * ambient host state. `noEnigma` is the isolated default for every test not
 * specifically exercising Enigma-first behavior.
 */
const noEnigma: TryEnigmaCredential = async () => undefined;

describe("basicAuthHeader", () => {
	it("base64-encodes username:apiToken", () => {
		expect(basicAuthHeader(CREDENTIALS)).toBe(`Basic ${Buffer.from("alice:tok123").toString("base64")}`);
	});
});

describe("fetchCrumb", () => {
	it("returns the crumb field and value on success", async () => {
		const fetchImpl: FetchLike = async () =>
			new Response(JSON.stringify({ crumb: "abc123", crumbRequestField: "Jenkins-Crumb" }), { status: 200 });
		const crumb = await fetchCrumb(CREDENTIALS, fetchImpl);
		expect(crumb).toEqual({ field: "Jenkins-Crumb", value: "abc123" });
	});

	it("returns undefined, not an error, when the crumb issuer is disabled (404)", async () => {
		const fetchImpl: FetchLike = async () => new Response("", { status: 404 });
		expect(await fetchCrumb(CREDENTIALS, fetchImpl)).toBeUndefined();
	});
});

describe("withCrumbHeaders", () => {
	it("fetches and caches the crumb on first call, reusing it on subsequent calls", async () => {
		let crumbFetchCount = 0;
		const fetchImpl: FetchLike = async () => {
			crumbFetchCount++;
			return new Response(JSON.stringify({ crumb: "abc123", crumbRequestField: "Jenkins-Crumb" }), { status: 200 });
		};
		const cache = createCrumbCache();

		const first = await withCrumbHeaders(CREDENTIALS, cache, fetchImpl);
		const second = await withCrumbHeaders(CREDENTIALS, cache, fetchImpl);

		expect(first["Jenkins-Crumb"]).toBe("abc123");
		expect(second["Jenkins-Crumb"]).toBe("abc123");
		expect(crumbFetchCount).toBe(1); // cached, not refetched
		expect(first.authorization).toBe(basicAuthHeader(CREDENTIALS));
	});

	it("still attaches Authorization even when no crumb issuer exists", async () => {
		const fetchImpl: FetchLike = async () => new Response("", { status: 404 });
		const headers = await withCrumbHeaders(CREDENTIALS, createCrumbCache(), fetchImpl);
		expect(headers.authorization).toBe(basicAuthHeader(CREDENTIALS));
		expect(Object.keys(headers)).not.toContain("Jenkins-Crumb");
	});
});

describe("createFileCredentialStore", () => {
	it("round-trips credentials through save/load, one file per profile-qualified backend name", () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-jenkins-auth-"));
		try {
			const store = createFileCredentialStore(dir, "jenkins-a");
			expect(store.load()).toBeUndefined();
			store.save(CREDENTIALS);
			expect(store.load()).toEqual(CREDENTIALS);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps two profile-qualified servers in separate files, not colliding", () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-jenkins-auth-"));
		try {
			const aCredentials = { baseUrl: "https://jenkins-a.example.com", username: "a-bot", apiToken: "a-token" };
			const bCredentials = { baseUrl: "https://jenkins-b.example.com", username: "b-bot", apiToken: "b-token" };
			createFileCredentialStore(dir, "jenkins-a").save(aCredentials);
			createFileCredentialStore(dir, "jenkins-b").save(bCredentials);
			expect(createFileCredentialStore(dir, "jenkins-a").load()).toEqual(aCredentials);
			expect(createFileCredentialStore(dir, "jenkins-b").load()).toEqual(bCredentials);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("resolveJenkinsCredentials", () => {
	it("prefers environment variables over a stored file", async () => {
		const store = { load: () => CREDENTIALS, save: () => {}, clear: () => {} };
		const resolved = await resolveJenkinsCredentials(store, { JENKINS_URL: "https://env.example.com", JENKINS_USER: "bob", JENKINS_API_TOKEN: "envtok" }, noEnigma);
		expect(resolved).toEqual({ baseUrl: "https://env.example.com", username: "bob", apiToken: "envtok" });
	});

	it("falls back to the stored file when environment variables are incomplete", async () => {
		const store = { load: () => CREDENTIALS, save: () => {}, clear: () => {} };
		expect(await resolveJenkinsCredentials(store, { JENKINS_URL: "https://env.example.com" }, noEnigma)).toEqual(CREDENTIALS);
	});

	it("returns undefined when neither source has credentials", async () => {
		const store = { load: () => undefined, save: () => {}, clear: () => {} };
		expect(await resolveJenkinsCredentials(store, {}, noEnigma)).toBeUndefined();
	});

	it("prefers a running Enigma vault's credential over both environment variables and a stored file", async () => {
		const store = { load: () => CREDENTIALS, save: () => {}, clear: () => {} };
		const calls: string[] = [];
		const fromEnigma: TryEnigmaCredential = async (backend) => {
			calls.push(backend);
			return { accessToken: "enigma-jenkins-token", extra: { url: "https://enigma.jenkins.example.com", username: "enigma-bot" } };
		};
		const resolved = await resolveJenkinsCredentials(store, { JENKINS_URL: "https://env.example.com", JENKINS_USER: "bob", JENKINS_API_TOKEN: "envtok" }, fromEnigma);
		expect(calls).toEqual(["jenkins"]);
		expect(resolved).toEqual({ baseUrl: "https://enigma.jenkins.example.com", username: "enigma-bot", apiToken: "enigma-jenkins-token" });
	});

	it("falls through to env-then-store unchanged when Enigma's credential is missing the url/username extra fields it needs", async () => {
		const store = { load: () => CREDENTIALS, save: () => {}, clear: () => {} };
		const incompleteEnigma: TryEnigmaCredential = async () => ({ accessToken: "enigma-token-missing-extra" });
		const resolved = await resolveJenkinsCredentials(store, { JENKINS_URL: "https://env.example.com", JENKINS_USER: "bob", JENKINS_API_TOKEN: "envtok" }, incompleteEnigma);
		expect(resolved).toEqual({ baseUrl: "https://env.example.com", username: "bob", apiToken: "envtok" });
	});

	it("forwards ENIGMA_CLIENT_TOKEN as the registered-client token, instead of relying on Enigma's shared admin-token file", async () => {
		const store = { load: () => undefined, save: () => {}, clear: () => {} };
		const seenTokens: (string | undefined)[] = [];
		const fromEnigma: TryEnigmaCredential = async (_backend, opts) => {
			seenTokens.push(opts?.token);
			return undefined;
		};
		await resolveJenkinsCredentials(store, { ENIGMA_CLIENT_TOKEN: "pipes-scoped-token" }, fromEnigma);
		expect(seenTokens).toEqual(["pipes-scoped-token"]);
	});
});

describe("resolveJenkinsCredentialsForBaseUrl: multiple independent Jenkins server targets", () => {
	it("never consults JENKINS_URL/JENKINS_USER/JENKINS_API_TOKEN -- a named target can't share one ambient env triple with another", async () => {
		const store = { load: () => undefined, save: () => {}, clear: () => {} };
		const resolved = await resolveJenkinsCredentialsForBaseUrl(
			store,
			"https://jenkins-a.example.com",
			{ JENKINS_URL: "https://jenkins-a.example.com", JENKINS_USER: "bob", JENKINS_API_TOKEN: "envtok" },
			noEnigma,
		);
		expect(resolved).toBeUndefined();
	});

	it("falls back to the stored file when Enigma has nothing", async () => {
		const store = { load: () => CREDENTIALS, save: () => {}, clear: () => {} };
		expect(await resolveJenkinsCredentialsForBaseUrl(store, CREDENTIALS.baseUrl, {}, noEnigma)).toEqual(CREDENTIALS);
	});

	it("uses Enigma's credential only when its stored url matches this target's baseUrl -- never misattributes one server's credential to another", async () => {
		const store = { load: () => undefined, save: () => {}, clear: () => {} };
		const fromEnigma: TryEnigmaCredential = async () => ({
			accessToken: "a-token",
			extra: { url: "https://jenkins-a.example.com", username: "a-bot" },
		});
		const matching = await resolveJenkinsCredentialsForBaseUrl(store, "https://jenkins-a.example.com", {}, fromEnigma);
		expect(matching).toEqual({ baseUrl: "https://jenkins-a.example.com", username: "a-bot", apiToken: "a-token" });

		// Same Enigma answer, different target baseUrl -- must not silently reuse server A's credential for server B.
		const nonMatching = await resolveJenkinsCredentialsForBaseUrl(store, "https://jenkins-b.example.com", {}, fromEnigma);
		expect(nonMatching).toBeUndefined();
	});
});

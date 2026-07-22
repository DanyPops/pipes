import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "../../../src/adapters/github/auth.ts";
import {
	basicAuthHeader,
	createCrumbCache,
	createFileCredentialStore,
	fetchCrumb,
	resolveJenkinsCredentials,
	withCrumbHeaders,
} from "../../../src/adapters/jenkins/auth.ts";

const CREDENTIALS = { baseUrl: "https://jenkins.example.com", username: "alice", apiToken: "tok123" };

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
	it("round-trips credentials through save/load", () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-jenkins-auth-"));
		const path = join(dir, "credentials.json");
		try {
			const store = createFileCredentialStore(path);
			expect(store.load()).toBeUndefined();
			store.save(CREDENTIALS);
			expect(store.load()).toEqual(CREDENTIALS);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("resolveJenkinsCredentials", () => {
	it("prefers environment variables over a stored file", () => {
		const store = { load: () => CREDENTIALS, save: () => {}, clear: () => {} };
		const resolved = resolveJenkinsCredentials(store, { JENKINS_URL: "https://env.example.com", JENKINS_USER: "bob", JENKINS_API_TOKEN: "envtok" });
		expect(resolved).toEqual({ baseUrl: "https://env.example.com", username: "bob", apiToken: "envtok" });
	});

	it("falls back to the stored file when environment variables are incomplete", () => {
		const store = { load: () => CREDENTIALS, save: () => {}, clear: () => {} };
		expect(resolveJenkinsCredentials(store, { JENKINS_URL: "https://env.example.com" })).toEqual(CREDENTIALS);
	});

	it("returns undefined when neither source has credentials", () => {
		const store = { load: () => undefined, save: () => {}, clear: () => {} };
		expect(resolveJenkinsCredentials(store, {})).toBeUndefined();
	});
});

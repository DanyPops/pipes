import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TryEnigmaCredential } from "@danypops/enigma-client";
import { createFileCredentialStore, resolveReportPortalCredentials } from "../../src/reportportal/init.ts";

const CREDENTIALS = { baseUrl: "https://rp.example.com", project: "myproject", apiKey: "key123" };

/**
 * Never the real tryEnigmaCredential in a test: it does a real filesystem
 * check against $XDG_RUNTIME_DIR, and a real Enigma daemon may genuinely be
 * running on the machine executing this suite -- tests must never depend on
 * ambient host state. `noEnigma` is the isolated default for every test not
 * specifically exercising Enigma-first behavior.
 */
const noEnigma: TryEnigmaCredential = async () => undefined;

describe("createFileCredentialStore", () => {
	it("round-trips credentials through save/load, one file per profile-qualified backend name", () => {
		const dir = mkdtempSync(join(tmpdir(), "pipes-reportportal-init-"));
		try {
			const store = createFileCredentialStore(dir, "reportportal");
			expect(store.load()).toBeUndefined();
			store.save(CREDENTIALS);
			expect(store.load()).toEqual(CREDENTIALS);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("resolveReportPortalCredentials", () => {
	it("prefers environment variables over a stored file", async () => {
		const store = { load: () => CREDENTIALS, save: () => {} };
		const resolved = await resolveReportPortalCredentials(
			store,
			{ RP_URL: "https://env.example.com", RP_PROJECT: "env-project", RP_API_KEY: "envkey" },
			noEnigma,
		);
		expect(resolved).toEqual({ baseUrl: "https://env.example.com", project: "env-project", apiKey: "envkey" });
	});

	it("falls back to the stored file when environment variables are incomplete", async () => {
		const store = { load: () => CREDENTIALS, save: () => {} };
		expect(await resolveReportPortalCredentials(store, { RP_URL: "https://env.example.com" }, noEnigma)).toEqual(CREDENTIALS);
	});

	it("returns undefined, not a throw, when neither source has credentials", async () => {
		const store = { load: () => undefined, save: () => {} };
		expect(await resolveReportPortalCredentials(store, {}, noEnigma)).toBeUndefined();
	});

	it("prefers a running Enigma vault's credential over both environment variables and a stored file", async () => {
		const store = { load: () => CREDENTIALS, save: () => {} };
		const calls: string[] = [];
		const fromEnigma: TryEnigmaCredential = async (backend) => {
			calls.push(backend);
			return { accessToken: "enigma-key", extra: { url: "https://enigma.rp.example.com", project: "enigma-project" } };
		};
		const resolved = await resolveReportPortalCredentials(
			store,
			{ RP_URL: "https://env.example.com", RP_PROJECT: "env-project", RP_API_KEY: "envkey" },
			fromEnigma,
		);
		expect(calls).toEqual(["reportportal"]);
		expect(resolved).toEqual({ baseUrl: "https://enigma.rp.example.com", project: "enigma-project", apiKey: "enigma-key" });
	});

	it("falls through to env-then-store unchanged when Enigma's credential is missing the url/project extra fields it needs", async () => {
		const store = { load: () => CREDENTIALS, save: () => {} };
		const incompleteEnigma: TryEnigmaCredential = async () => ({ accessToken: "enigma-key-missing-extra" });
		const resolved = await resolveReportPortalCredentials(
			store,
			{ RP_URL: "https://env.example.com", RP_PROJECT: "env-project", RP_API_KEY: "envkey" },
			incompleteEnigma,
		);
		expect(resolved).toEqual({ baseUrl: "https://env.example.com", project: "env-project", apiKey: "envkey" });
	});

	it("forwards ENIGMA_CLIENT_TOKEN as the registered-client token, instead of relying on Enigma's shared admin-token file", async () => {
		const store = { load: () => undefined, save: () => {} };
		const seenTokens: (string | undefined)[] = [];
		const fromEnigma: TryEnigmaCredential = async (_backend, opts) => {
			seenTokens.push(opts?.token);
			return undefined;
		};
		await resolveReportPortalCredentials(store, { ENIGMA_CLIENT_TOKEN: "pipes-scoped-token" }, fromEnigma);
		expect(seenTokens).toEqual(["pipes-scoped-token"]);
	});
});

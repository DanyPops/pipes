import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileStore } from "@danypops/daemon-kit/vault";
import { buildPipesSecretsBackends } from "../src/secrets.ts";

function tempEnv(): { root: string; env: Record<string, string> } {
	const root = mkdtempSync(join(tmpdir(), "pi-pipes-secrets-"));
	return { root, env: { ...(process.env as Record<string, string>), XDG_STATE_HOME: join(root, "state") } };
}

describe("buildPipesSecretsBackends", () => {
	it("returns a local backend pointed at pipes' own credentials directory, and an env backend for the static-token fallbacks", async () => {
		const { root, env } = tempEnv();
		try {
			const credentialsDir = join(root, "state", "pipes");
			createFileStore(credentialsDir, "github").save({ accessToken: "gho_x" });
			const backends = buildPipesSecretsBackends({ env, home: root, uid: 1000 });
			expect(backends.map((b) => b.source).sort()).toEqual(["env", "local"]);

			const local = backends.find((b) => b.source === "local")!;
			expect(await local.get("github")).toEqual({ name: "github", source: "local", configured: true });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("the env backend reflects GITHUB_TOKEN/GITLAB_TOKEN presence", async () => {
		const { root, env } = tempEnv();
		try {
			const backends = buildPipesSecretsBackends({ env: { ...env, GITHUB_TOKEN: "ghp_x", GITLAB_TOKEN: "" }, home: root, uid: 1000 });
			const envBackend = backends.find((b) => b.source === "env")!;
			expect(await envBackend.list()).toEqual([
				{ name: "github", source: "env", configured: true },
				{ name: "gitlab", source: "env", configured: false },
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

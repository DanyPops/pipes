/** Bun composition root: binds and serves via @danypops/vehicle-server's runDaemonProcess. */
import { buildConfiguredAdapters } from "./adapters/config.ts";
import { runDaemonProcess } from "@danypops/vehicle-server/daemon";
import { createLogger } from "@danypops/vehicle-server/logging";
import { ensureAuthToken } from "@danypops/vehicle-server/paths";
import { RUN_POOL_SYNC_INTERVAL_MS } from "./constants.ts";
import { openPipesDb } from "./db.ts";
import { Orchestrator } from "./orchestrator.ts";
import { resolvePipesCredentialPaths, resolvePipesPaths } from "./paths.ts";
import { syncRunPool } from "./pool-sync.ts";
import { defaultPresetsPath, loadPresets } from "./presets.ts";
import { defaultRepoConfigPath, loadRepoConfig } from "./repo-config.ts";
import { createRunPool } from "./run-pool.ts";
import { createApp, createPipesService } from "./service.ts";

const logger = createLogger("pipes");

async function buildOrchestrator(credentialPaths: ReturnType<typeof resolvePipesCredentialPaths>): Promise<Orchestrator> {
	const orchestrator = new Orchestrator();
	const repoConfig = loadRepoConfig(defaultRepoConfigPath());
	const { adapters, unconfigured } = await buildConfiguredAdapters(credentialPaths, process.env, undefined, repoConfig);
	for (const adapter of adapters) orchestrator.addAdapter(adapter);
	orchestrator.registerUnconfigured(unconfigured);
	for (const pipeline of loadPresets(defaultPresetsPath())) {
		orchestrator.registerPipeline(pipeline);
	}
	return orchestrator;
}

export async function serveMain(): Promise<void> {
	const paths = resolvePipesPaths();
	const token = ensureAuthToken(paths.token, "Pipes");
	const credentialPaths = resolvePipesCredentialPaths(paths);
	const orchestrator = await buildOrchestrator(credentialPaths);
	const db = openPipesDb(paths.database);
	const runPool = createRunPool(db);
	const service = createPipesService(orchestrator, { runPool });

	runDaemonProcess({
		daemonLabel: "Pipes",
		handlePath: paths.handle,
		logger,
		buildApp: () => createApp({ service, token }),
		maintenanceTasks: [{ name: "run-pool-sync", intervalMs: RUN_POOL_SYNC_INTERVAL_MS, run: () => syncRunPool(orchestrator, runPool, logger) }],
		onShutdown: () => db.close(),
		onListen: ({ host, port }) => logger.info("listening", { host, port }),
	});
}

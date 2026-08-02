/** Bun composition root: binds and serves via @danypops/vehicle-server's runDaemonProcess. */

import { runDaemonProcess } from "@danypops/vehicle-server/daemon";
import { createLogger } from "@danypops/vehicle-server/logging";
import { ensureAuthToken } from "@danypops/vehicle-server/paths";
import { PushChannel } from "@danypops/vehicle-server/push-channel";
import { buildConfiguredAdapters } from "../config/config.ts";
import { defaultPresetsPath, loadPresets } from "../config/presets.ts";
import { defaultRepoConfigPath, loadRepoConfig } from "../config/repo-config.ts";
import { RUN_POOL_SYNC_INTERVAL_MS } from "../constants.ts";
import { Orchestrator } from "../orchestrator.ts";
import { resolvePipesCredentialPaths, resolvePipesPaths } from "../paths.ts";
import { createApp, createPipesService } from "../rpc/service.ts";
import { openPipesDb } from "../sqlite/db.ts";
import { createRunPool } from "../sqlite/run-pool.ts";
import { syncRunPool } from "./pool-sync.ts";

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
	const pushChannel = new PushChannel({ token });

	runDaemonProcess({
		daemonLabel: "Pipes",
		handlePath: paths.handle,
		logger,
		pushChannel,
		buildApp: () => createApp({ service, token }),
		maintenanceTasks: [
			{
				name: "run-pool-sync",
				intervalMs: RUN_POOL_SYNC_INTERVAL_MS,
				// Publishes under the "ci" topic so a subscribed client (e.g. Alignment's future
				// CI Surface) sees a run's queued -> running -> success/failure transitions live,
				// instead of needing to poll ci.pool/ci.tail itself.
				run: () => syncRunPool(orchestrator, runPool, logger, (transition) => pushChannel.publish("ci", transition)),
			},
		],
		onShutdown: () => db.close(),
		onListen: ({ host, port }) => logger.info("listening", { host, port }),
	});
}

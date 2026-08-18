/** Bun composition root: binds and serves via @danypops/vehicle-server's runDaemonProcess. */

import { runDaemonProcess } from "@danypops/vehicle-server/daemon";
import { createLogger } from "@danypops/vehicle-server/logging";
import { openVehicleMetricsStore } from "@danypops/vehicle-server/metrics";
import { createVehicleMetricsMiddleware } from "@danypops/vehicle-server/metrics-middleware";
import { registerVehicleMetricsOperations } from "@danypops/vehicle-server/metrics-operations";
import { ensureAuthToken } from "@danypops/vehicle-server/paths";
import { PushChannel } from "@danypops/vehicle-server/push-channel";
import { buildConfiguredAdapters } from "../config/config.ts";
import { defaultPresetsPath, loadPresets } from "../config/presets.ts";
import { defaultRepoConfigPath, loadRepoConfig } from "../config/repo-config.ts";
import { RUN_POOL_SYNC_INTERVAL_MS, VEHICLE_NAME } from "../constants.ts";
import { Orchestrator } from "../orchestrator.ts";
import { resolvePipesCredentialPaths, resolvePipesPaths } from "../paths.ts";
import { buildConfiguredReportPortalAdapter } from "../reportportal/init.ts";
import { createApp, createPipesService } from "../rpc/service.ts";
import { openPipesDb } from "../sqlite/db.ts";
import { createRunPool, createSqliteVehicleProjectStore } from "../sqlite/run-pool.ts";
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
	// A single optional LaunchBackend, not a multi-adapter registry like Orchestrator's CIBackend
	// map -- Report Portal is deliberately not part of Orchestrator (see reportportal/launch-backend.ts).
	const launchBackend = await buildConfiguredReportPortalAdapter(credentialPaths);
	const db = openPipesDb(paths.database);
	const runPool = createRunPool(db);
	const projectStore = createSqliteVehicleProjectStore(db);
	const service = createPipesService(orchestrator, { runPool, launchBackend, projectStore });
	// Records how often each real operation is invoked (server-side, every caller) plus, via
	// metrics.recordClientEvent, client-observed Vehicle Shell meta-tool calls -- see
	// @danypops/vehicle-server's own metrics README section. Wired directly onto the same registry
	// every real Pipes operation is already registered on (service.vehicle), so it's discoverable
	// through the exact same tools_list/tools_man path as any other operation.
	const metrics = openVehicleMetricsStore(paths.metrics);
	service.vehicle.useExecutionMiddleware(createVehicleMetricsMiddleware(metrics, VEHICLE_NAME));
	registerVehicleMetricsOperations(service.vehicle, metrics, VEHICLE_NAME);
	const pushChannel = new PushChannel({ token });

	runDaemonProcess({
		daemonLabel: "Pipes",
		handlePath: paths.handle,
		// Registers Pipes into the shared, cross-package Vehicle Handle Directory (see
		// @danypops/vehicle-server's startDaemon) -- the seam Vehicle Shell broker mode discovers
		// Pipes through, alongside its own private handle above. tokenPath lets a discovering
		// broker authenticate; write/remove failures are logged, never fatal (startDaemon's own
		// contract).
		vehicleName: VEHICLE_NAME,
		tokenPath: paths.token,
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
		onShutdown: () => {
			db.close();
			metrics.close();
		},
		onListen: ({ host, port }) => logger.info("listening", { host, port }),
	});
}

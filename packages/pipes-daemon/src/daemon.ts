/** Bun composition root: binds and serves via @danypops/daemon-kit's runDaemonProcess. */
import { runDaemonProcess } from "@danypops/daemon-kit/daemon";
import { createLogger } from "@danypops/daemon-kit/logging";
import { ensureAuthToken } from "@danypops/daemon-kit/paths";
import { Orchestrator } from "./orchestrator.ts";
import { resolvePipesPaths } from "./paths.ts";
import { defaultPresetsPath, loadPresets } from "./presets.ts";
import { createApp, createPipesService } from "./service.ts";

const logger = createLogger("pipes-daemon");

/** No real CIBackend adapters are registered here yet — GitHub/GitLab/Jenkins/Prow each add an orchestrator.addAdapter() call once built. */
function buildOrchestrator(): Orchestrator {
	const orchestrator = new Orchestrator();
	for (const pipeline of loadPresets(defaultPresetsPath())) {
		orchestrator.registerPipeline(pipeline);
	}
	return orchestrator;
}

export function serveMain(): void {
	const paths = resolvePipesPaths();
	const token = ensureAuthToken(paths.token, "Pipes");
	const service = createPipesService(buildOrchestrator());

	runDaemonProcess({
		daemonLabel: "Pipes",
		handlePath: paths.handle,
		logger,
		buildApp: () => createApp({ service, token }),
		onListen: ({ host, port }) => logger.info("listening", { host, port }),
	});
}

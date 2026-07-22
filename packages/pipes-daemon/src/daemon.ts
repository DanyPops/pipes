/** Bun composition root: binds and serves via @danypops/daemon-kit's runDaemonProcess. */
import { runDaemonProcess } from "@danypops/daemon-kit/daemon";
import { createLogger } from "@danypops/daemon-kit/logging";
import { ensureAuthToken } from "@danypops/daemon-kit/paths";
import { resolvePipesPaths } from "./paths.ts";
import { createApp, createPipesService } from "./service.ts";

const logger = createLogger("pipes-daemon");

export function serveMain(): void {
	const paths = resolvePipesPaths();
	const token = ensureAuthToken(paths.token, "Pipes");
	const service = createPipesService();

	runDaemonProcess({
		daemonLabel: "Pipes",
		handlePath: paths.handle,
		logger,
		buildApp: () => createApp({ service, token }),
		onListen: ({ host, port }) => logger.info("listening", { host, port }),
	});
}

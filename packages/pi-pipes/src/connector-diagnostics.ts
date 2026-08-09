import { isLikelyStaleConnectionError } from "@danypops/vehicle-client/daemon-client";
import { type VehicleClient, VehicleError } from "@danypops/vehicle-core";

// biome-ignore lint/complexity/useRegexLiterals: a constructor avoids control-character lint on the equivalent literal.
const CONTROL_CHARACTER_PATTERN = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

function safeIdentity(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	return value.replace(CONTROL_CHARACTER_PATTERN, "?").slice(0, 120);
}

/** Adds a typed, bounded connector boundary without exposing the dead URL, token, or raw fetch cause. */
export function withConnectorDiagnostics(client: VehicleClient): VehicleClient {
	return {
		manifest: () => client.manifest(),
		async invoke(name, version, input, options) {
			try {
				return await client.invoke(name, version, input, options);
			} catch (error) {
				if (!isLikelyStaleConnectionError(error)) throw error;
				const fields = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
				const pipeline = safeIdentity(fields.pipeline);
				const backend = safeIdentity(fields.backend);
				const identity = pipeline ? `pipeline "${pipeline}"` : backend ? `backend "${backend}"` : "Pipes connector";
				const details: Record<string, string> = { operation: name, connector: "unavailable" };
				if (pipeline) details.pipeline = pipeline;
				if (backend) details.backend = backend;
				throw new VehicleError(
					"connector-unavailable",
					`connector unavailable during ${name} for ${identity}; retry after Pipes daemon recovery`,
					{
						category: "unavailable",
						retryable: true,
						recovery: { operation: name, message: "Retry after the Pipes daemon is reachable." },
						details,
					},
				);
			}
		},
		close: () => client.close(),
	};
}

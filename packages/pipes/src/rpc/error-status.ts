import {
	BackendNotFoundError,
	CapabilityUnsupportedError,
	NotOwnedError,
	PipelineNotFoundError,
	StepOutOfRangeError,
} from "../orchestrator.ts";

/** Returns the legacy HTTP status only for reviewed business errors; unknown failures stay unclassified. */
export function statusForKnownPipesError(error: unknown): number | undefined {
	if (error instanceof BackendNotFoundError || error instanceof PipelineNotFoundError) return 404;
	if (error instanceof NotOwnedError) return 403;
	if (error instanceof CapabilityUnsupportedError || error instanceof StepOutOfRangeError) return 400;
	return undefined;
}

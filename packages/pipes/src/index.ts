export {
	connectPipesClient,
	createPipesClient,
	type EnsureDaemonOptions,
	ensureDaemonRunning,
	type PipesClient,
	resolveVehicleClientTarget,
	type VehicleClientTarget,
} from "./cli/client.ts";
export { type PipesCredentialPaths, profiledBackend, resolvePipesCredentialPaths, resolvePipesPaths } from "./paths.ts";
export type { OperationInputs, OperationName, OperationOutputs } from "./rpc/service.ts";
export type { BackendInfo } from "./run/backend.ts";
// The public surface a third-party CI backend adapter is written against -- CIBackend itself, its
// six optional capability interfaces, the Capability bitmask, and the asXxx()/unwrapBackend() guards
// -- previously unreachable from outside this package (see the config.ts registry alongside this).
export * from "./run/ci-backend.ts";
export type {
	BuildFilter,
	CIArtifact,
	CIJob,
	CIRun,
	CIRunNode,
	CIStageNode,
	LogFilter,
	LogResult,
	RunResult,
	RunStatus,
	SearchResult,
} from "./run/ci-run.ts";
export type { RepoInfo, WorkflowInfo } from "./run/discovery.ts";
export type { Pipeline, PipelineRun, PipelineStep } from "./run/pipeline.ts";
export type { TriggerReceipt, TriggerResult, WatchStatus } from "./run/trigger.ts";
export type { RunSnapshot } from "./sqlite/run-pool.ts";

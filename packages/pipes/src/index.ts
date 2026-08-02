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
export type { CIRunNode, CIStageNode, LogResult, RunResult, RunStatus } from "./run/ci-run.ts";
export type { RepoInfo, WorkflowInfo } from "./run/discovery.ts";
export type { Pipeline, PipelineRun, PipelineStep } from "./run/pipeline.ts";
export type { TriggerResult, WatchStatus } from "./run/trigger.ts";
export type { RunSnapshot } from "./sqlite/run-pool.ts";

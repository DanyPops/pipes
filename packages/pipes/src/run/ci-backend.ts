import type { BuildFilter, CIArtifact, CIJob, CIRun, CIStageNode, LogFilter, SearchResult } from "./ci-run.ts";
import type { RepoInfo, WorkflowInfo } from "./discovery.ts";
import type { TriggerReceipt } from "./trigger.ts";

export enum Capability {
	Trigger = 1 << 0,
	History = 1 << 1,
	Stages = 1 << 2,
	Artifacts = 1 << 3,
	Chain = 1 << 4,
	Discover = 1 << 5,
	Rerun = 1 << 6,
}

export type CapabilitySet = number;

export function hasCapability(set: CapabilitySet, capability: Capability): boolean {
	return (set & capability) === capability;
}

const CAPABILITY_NAMES: [Capability, string][] = [
	[Capability.Trigger, "trigger"],
	[Capability.History, "history"],
	[Capability.Stages, "stages"],
	[Capability.Artifacts, "artifacts"],
	[Capability.Chain, "chain"],
	[Capability.Discover, "discover"],
	[Capability.Rerun, "rerun"],
];

export function describeCapabilities(set: CapabilitySet): string {
	const names = CAPABILITY_NAMES.filter(([capability]) => hasCapability(set, capability)).map(([, name]) => name);
	return names.length > 0 ? names.join(" ") : "none";
}

/**
 * Mandatory minimum every CI backend must implement: read-only run
 * observation plus cancel. runId "latest" is an explicit sentinel for the
 * most recent run — a specific runId must always resolve to that exact
 * run, never silently fall back to latest.
 */
export interface CIBackend {
	name(): string;
	type(): string;
	capabilities(): CapabilitySet;
	getRun(jobRef: string, runId: string): Promise<CIRun>;
	searchRuns(jobRef: string, filter: BuildFilter): Promise<SearchResult>;
	/** Returns the raw console log; filter is only a hint for backends that support server-side filtering — the orchestrator applies the authoritative tail/grep/byte-cap filtering. */
	getLog(jobRef: string, runId: string, filter: LogFilter): Promise<string>;
	cancelRun(jobRef: string, runId: string): Promise<void>;
}

export interface CITriggerable {
	trigger(jobRef: string, params: Record<string, string>): Promise<TriggerReceipt>;
	resolveReceipt(receipt: TriggerReceipt): Promise<TriggerReceipt>;
	estimateDuration(jobRef: string): Promise<number>;
}

export interface CIHistorical {
	listRuns(jobRef: string, limit: number): Promise<CIRun[]>;
	getRunParams(jobRef: string, runId: string): Promise<Record<string, string>>;
}

export interface CIPipeliner {
	listStages(jobRef: string, runId: string): Promise<CIJob[]>;
	listStageNodes(jobRef: string, runId: string): Promise<CIStageNode[]>;
	/** Like listStageNodes but attaches each failed step's log where the backend can do so efficiently. */
	listStageNodesWithLogs(jobRef: string, runId: string): Promise<CIStageNode[]>;
}

export interface CIRerunnable {
	rerun(jobRef: string, runId: string, failedOnly: boolean): Promise<void>;
}

export interface CIArtifactStore {
	listArtifacts(jobRef: string, runId: string): Promise<CIArtifact[]>;
	getArtifact(jobRef: string, runId: string, path: string, maxBytes: number): Promise<Uint8Array>;
}

export interface CIChainable {
	getDownstreamRuns(downstreamJob: string, upstreamJob: string, upstreamRunId: string): Promise<CIRun[]>;
}

/** Lets a caller explore what's actually addressable through a backend instead of already knowing the exact repo/workflow name -- most relevant for an account-scoped backend covering many repos under one owner. */
export interface CIDiscoverable {
	listRepos(): Promise<RepoInfo[]>;
	listWorkflows(repo: string): Promise<WorkflowInfo[]>;
}

/** Implemented by decorator adapters (e.g. a future cache layer) to expose the wrapped backend. */
export interface Unwrappable {
	unwrap(): CIBackend;
}

function isUnwrappable(backend: CIBackend): backend is CIBackend & Unwrappable {
	return typeof (backend as Partial<Unwrappable>).unwrap === "function";
}

/** Peels through Unwrappable decorators to reach the real backend, mirroring conty's As[T]. */
export function unwrapBackend(backend: CIBackend): CIBackend {
	return isUnwrappable(backend) ? unwrapBackend(backend.unwrap()) : backend;
}

/**
 * Resolves the given optional capability on the real (unwrapped) backend,
 * or undefined if unsupported. Always peels through decorators first so a
 * wrapper's delegating stub can never report a capability the underlying
 * backend doesn't actually have — e.g. asTriggerable(cache(githubAdapter))
 * is undefined because githubAdapter itself has no trigger, even if the
 * cache decorator's type declares it.
 */
function asCapability<T>(backend: CIBackend, method: keyof T): T | undefined {
	const target = unwrapBackend(backend) as unknown as Partial<T>;
	return typeof target[method] === "function" ? (target as T) : undefined;
}

export function asTriggerable(backend: CIBackend): (CIBackend & CITriggerable) | undefined {
	return asCapability<CIBackend & CITriggerable>(backend, "trigger");
}

export function asHistorical(backend: CIBackend): (CIBackend & CIHistorical) | undefined {
	return asCapability<CIBackend & CIHistorical>(backend, "listRuns");
}

export function asPipeliner(backend: CIBackend): (CIBackend & CIPipeliner) | undefined {
	return asCapability<CIBackend & CIPipeliner>(backend, "listStages");
}

export function asRerunnable(backend: CIBackend): (CIBackend & CIRerunnable) | undefined {
	return asCapability<CIBackend & CIRerunnable>(backend, "rerun");
}

export function asArtifactStore(backend: CIBackend): (CIBackend & CIArtifactStore) | undefined {
	return asCapability<CIBackend & CIArtifactStore>(backend, "listArtifacts");
}

export function asChainable(backend: CIBackend): (CIBackend & CIChainable) | undefined {
	return asCapability<CIBackend & CIChainable>(backend, "getDownstreamRuns");
}

export function asDiscoverable(backend: CIBackend): (CIBackend & CIDiscoverable) | undefined {
	return asCapability<CIBackend & CIDiscoverable>(backend, "listRepos");
}

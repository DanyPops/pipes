/** Configurable fake CIBackend for tests, mirroring conty's driventest.StubCIAdapter. */

import {
	Capability,
	type CapabilitySet,
	type CIArtifactStore,
	type CIBackend,
	type CIChainable,
	type CIDiscoverable,
	type CIHistorical,
	type CIPipeliner,
	type CIRerunnable,
	type CITriggerable,
} from "../../src/run/ci-backend.ts";
import type { CIArtifact, CIJob, CIRun, CIStageNode } from "../../src/run/ci-run.ts";
import type { RepoInfo, WorkflowInfo } from "../../src/run/discovery.ts";
import type { TriggerReceipt } from "../../src/run/trigger.ts";

export interface StubCIBackendOptions {
	name?: string;
	capabilities?: CapabilitySet;
	run?: CIRun;
	/** getRun keys its response by runId so distinct-ID tests are meaningful by default. */
	runsById?: Record<string, CIRun>;
	searchResults?: CIRun[];
	/** Mirrors SearchResult.truncated -- defaults to false, matching a real backend that reached a genuine stopping point. */
	searchTruncated?: boolean;
	/** Raw log text (unfiltered) — matches the CIBackend.getLog contract. */
	log?: string;
	stages?: CIJob[];
	stageNodes?: CIStageNode[];
	artifacts?: CIArtifact[];
	artifactBytes?: Uint8Array;
	runParams?: Record<string, string>;
	listRunsResult?: CIRun[];
	downstreamRuns?: CIRun[];
	repos?: RepoInfo[];
	workflows?: WorkflowInfo[];
	triggerReceipt?: TriggerReceipt;
	rerun?: boolean;
	resolvedReceipt?: TriggerReceipt;
	estimatedDurationMs?: number;
	err?: Error;
}

export type StubCIBackend = CIBackend &
	Partial<CITriggerable & CIHistorical & CIPipeliner & CIArtifactStore & CIChainable & CIDiscoverable & CIRerunnable> & {
		calls: {
			getRun: Array<{ jobRef: string; runId: string }>;
			trigger: Array<{ jobRef: string; params: Record<string, string> }>;
			resolveReceipt: TriggerReceipt[];
			rerun: Array<{ jobRef: string; runId: string; failedOnly: boolean }>;
		};
	};

/** Core-only backend: implements just the CIBackend mandatory methods, no optional capabilities. */
export function createStubCIBackend(options: StubCIBackendOptions = {}): StubCIBackend {
	const calls: StubCIBackend["calls"] = { getRun: [], trigger: [], resolveReceipt: [], rerun: [] };
	const name = options.name ?? "stub";

	const core: CIBackend = {
		name: () => name,
		type: () => "stub",
		capabilities: () => options.capabilities ?? 0,
		getRun: async (jobRef, runId) => {
			calls.getRun.push({ jobRef, runId });
			if (options.err) throw options.err;
			const byId = options.runsById?.[runId];
			if (byId) return byId;
			if (options.run) return { ...options.run, id: runId };
			return { id: runId, name: jobRef, status: "success", startedAt: new Date(0) };
		},
		searchRuns: async () => ({ runs: options.searchResults ?? [], truncated: options.searchTruncated ?? false }),
		getLog: async () => options.log ?? "",
		cancelRun: async () => {
			if (options.err) throw options.err;
		},
	};

	const capabilities = options.capabilities ?? 0;
	const stub: StubCIBackend = { ...core, calls };

	if ((capabilities & Capability.Trigger) === Capability.Trigger) {
		Object.assign(stub, {
			trigger: async (jobRef: string, params: Record<string, string>) => {
				calls.trigger.push({ jobRef, params });
				if (options.err) throw options.err;
				return options.triggerReceipt ?? { needsResolve: false, backend: name, jobRef, runId: "1" };
			},
			resolveReceipt: async (receipt: TriggerReceipt) => {
				calls.resolveReceipt.push(receipt);
				return options.resolvedReceipt ?? receipt;
			},
			estimateDuration: async () => options.estimatedDurationMs ?? 0,
		} satisfies CITriggerable);
	}

	if ((capabilities & Capability.Rerun) === Capability.Rerun) {
		Object.assign(stub, {
			rerun: async (jobRef: string, runId: string, failedOnly: boolean) => {
				calls.rerun.push({ jobRef, runId, failedOnly });
				if (options.err) throw options.err;
			},
		} satisfies CIRerunnable);
	}

	if ((capabilities & Capability.History) === Capability.History) {
		Object.assign(stub, {
			listRuns: async () => options.listRunsResult ?? [],
			getRunParams: async () => options.runParams ?? {},
		} satisfies CIHistorical);
	}

	if ((capabilities & Capability.Stages) === Capability.Stages) {
		Object.assign(stub, {
			listStages: async () => options.stages ?? [],
			listStageNodes: async () => options.stageNodes ?? [],
			listStageNodesWithLogs: async () => options.stageNodes ?? [],
		} satisfies CIPipeliner);
	}

	if ((capabilities & Capability.Artifacts) === Capability.Artifacts) {
		Object.assign(stub, {
			listArtifacts: async () => options.artifacts ?? [],
			getArtifact: async () => options.artifactBytes ?? new Uint8Array(),
		} satisfies CIArtifactStore);
	}

	if ((capabilities & Capability.Chain) === Capability.Chain) {
		Object.assign(stub, {
			getDownstreamRuns: async () => options.downstreamRuns ?? [],
		} satisfies CIChainable);
	}

	if ((capabilities & Capability.Discover) === Capability.Discover) {
		Object.assign(stub, {
			listRepos: async () => options.repos ?? [],
			listWorkflows: async () => options.workflows ?? [],
		} satisfies CIDiscoverable);
	}

	return stub;
}

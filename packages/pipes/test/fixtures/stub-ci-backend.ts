/** Configurable fake CIBackend for tests, mirroring conty's driventest.StubCIAdapter. */
import type { CIArtifact, CIJob, CIRun, CIStageNode } from "../../src/domain/ci-run.ts";
import type { TriggerReceipt } from "../../src/domain/trigger.ts";
import {
	Capability,
	type CapabilitySet,
	type CIArtifactStore,
	type CIBackend,
	type CIChainable,
	type CIHistorical,
	type CIPipeliner,
	type CITriggerable,
} from "../../src/ports/ci-backend.ts";

export interface StubCIBackendOptions {
	name?: string;
	capabilities?: CapabilitySet;
	run?: CIRun;
	/** getRun keys its response by runId so distinct-ID tests are meaningful by default. */
	runsById?: Record<string, CIRun>;
	searchResults?: CIRun[];
	/** Raw log text (unfiltered) — matches the CIBackend.getLog contract. */
	log?: string;
	stages?: CIJob[];
	stageNodes?: CIStageNode[];
	artifacts?: CIArtifact[];
	runParams?: Record<string, string>;
	listRunsResult?: CIRun[];
	downstreamRuns?: CIRun[];
	triggerReceipt?: TriggerReceipt;
	resolvedReceipt?: TriggerReceipt;
	estimatedDurationMs?: number;
	err?: Error;
}

export type StubCIBackend = CIBackend &
	Partial<CITriggerable & CIHistorical & CIPipeliner & CIArtifactStore & CIChainable> & {
		calls: { getRun: Array<{ jobRef: string; runId: string }>; trigger: Array<{ jobRef: string; params: Record<string, string> }> };
	};

/** Core-only backend: implements just the CIBackend mandatory methods, no optional capabilities. */
export function createStubCIBackend(options: StubCIBackendOptions = {}): StubCIBackend {
	const calls: StubCIBackend["calls"] = { getRun: [], trigger: [] };
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
		searchRuns: async () => options.searchResults ?? [],
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
			resolveReceipt: async (receipt: TriggerReceipt) => options.resolvedReceipt ?? receipt,
			estimateDuration: async () => options.estimatedDurationMs ?? 0,
		} satisfies CITriggerable);
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
			getArtifact: async () => new Uint8Array(),
		} satisfies CIArtifactStore);
	}

	if ((capabilities & Capability.Chain) === Capability.Chain) {
		Object.assign(stub, {
			getDownstreamRuns: async () => options.downstreamRuns ?? [],
		} satisfies CIChainable);
	}

	return stub;
}

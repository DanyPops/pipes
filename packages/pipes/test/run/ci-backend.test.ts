import { describe, expect, it } from "bun:test";
import {
	asArtifactStore,
	asChainable,
	asHistorical,
	asPipeliner,
	asTriggerable,
	Capability,
	type CIBackend,
	describeCapabilities,
	hasCapability,
	unwrapBackend,
} from "../../src/run/ci-backend.ts";
import { isTerminalStatus } from "../../src/run/ci-run.ts";
import { createStubCIBackend } from "../fixtures/stub-ci-backend.ts";

describe("capability bitmask", () => {
	it("combines and detects flags", () => {
		const set = Capability.Trigger | Capability.Artifacts;
		expect(hasCapability(set, Capability.Trigger)).toBe(true);
		expect(hasCapability(set, Capability.History)).toBe(false);
	});

	it("describes an empty set as none", () => {
		expect(describeCapabilities(0)).toBe("none");
	});

	it("describes a combined set in a stable order", () => {
		expect(describeCapabilities(Capability.Artifacts | Capability.Trigger)).toBe("trigger artifacts");
	});
});

describe("capability accessors (asTriggerable, etc.)", () => {
	it("returns undefined for a backend missing the capability", () => {
		const core = createStubCIBackend();
		expect(asTriggerable(core)).toBeUndefined();
		expect(asHistorical(core)).toBeUndefined();
		expect(asPipeliner(core)).toBeUndefined();
		expect(asArtifactStore(core)).toBeUndefined();
		expect(asChainable(core)).toBeUndefined();
	});

	it("returns the backend when the capability is present", async () => {
		const backend = createStubCIBackend({
			capabilities: Capability.Trigger,
			triggerReceipt: { needsResolve: false, backend: "full", jobRef: "job", runId: "42" },
		});
		const triggerable = asTriggerable(backend);
		expect(triggerable).toBeDefined();
		const receipt = await triggerable?.trigger("job", {});
		expect(receipt?.runId).toBe("42");
	});

	it("peels through a decorator to reflect the real backend's capabilities, not the wrapper's", () => {
		const inner = createStubCIBackend({ name: "inner" });
		// A decorator that structurally has a `trigger` method itself (as a
		// caching/logging wrapper's delegation stub might) but wraps a core-only
		// backend — the capability must reflect the wrapped backend, not the
		// wrapper's own shape.
		const wrapper: CIBackend & { unwrap(): CIBackend } = {
			...createStubCIBackend({ name: "wrapper", capabilities: Capability.Trigger }),
			unwrap: () => inner,
		};
		expect(unwrapBackend(wrapper)).toBe(inner);
		expect(asTriggerable(wrapper)).toBeUndefined();
	});
});

describe("CIRun.status", () => {
	it("classifies terminal vs non-terminal statuses", () => {
		expect(isTerminalStatus("success")).toBe(true);
		expect(isTerminalStatus("failure")).toBe(true);
		expect(isTerminalStatus("aborted")).toBe(true);
		expect(isTerminalStatus("not_found")).toBe(true);
		expect(isTerminalStatus("running")).toBe(false);
		expect(isTerminalStatus("pending")).toBe(false);
	});
});

describe("getRun contract (explicit run_id must not resolve to latest)", () => {
	it("returns a distinct run for each distinct runId", async () => {
		const backend = createStubCIBackend();
		const runA = await backend.getRun("job", "A");
		const runB = await backend.getRun("job", "B");
		expect(runA.id).toBe("A");
		expect(runB.id).toBe("B");
		expect(runA.id).not.toBe(runB.id);
	});

	it("records every getRun call for assertions in adapter-specific tests", async () => {
		const backend = createStubCIBackend();
		await backend.getRun("job", "1");
		await backend.getRun("job", "2");
		expect(backend.calls.getRun).toEqual([
			{ jobRef: "job", runId: "1" },
			{ jobRef: "job", runId: "2" },
		]);
	});
});

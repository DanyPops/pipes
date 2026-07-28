import { describe, expect, it } from "bun:test";
import type { CIRun } from "../src/domain/ci-run.ts";
import type { Pipeline } from "../src/domain/pipeline.ts";
import {
	applyLogFilter,
	BackendNotFoundError,
	CapabilityUnsupportedError,
	NotOwnedError,
	Orchestrator,
	PipelineNotFoundError,
} from "../src/orchestrator.ts";
import { Capability } from "../src/ports/ci-backend.ts";
import { createStubCIBackend } from "./fixtures/stub-ci-backend.ts";

describe("Orchestrator: backends and pipelines registry", () => {
	it("throws BackendNotFoundError for an unregistered backend", async () => {
		const orchestrator = new Orchestrator();
		await expect(orchestrator.ciGetRun("missing", "job", "1")).rejects.toThrow(BackendNotFoundError);
	});

	it("throws PipelineNotFoundError for an unregistered pipeline", async () => {
		const orchestrator = new Orchestrator();
		await expect(orchestrator.triggerPipeline("missing")).rejects.toThrow(PipelineNotFoundError);
	});

	it("lists configured and unconfigured backends via backendInfo", () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", capabilities: Capability.Trigger }));
		orchestrator.registerUnconfigured([{ name: "gitlab", type: "gitlab" }]);
		const infos = orchestrator.backendInfo();
		expect(infos).toContainEqual({ name: "gh", type: "stub", capabilities: "trigger" });
		expect(infos).toContainEqual({ name: "gitlab", type: "gitlab", capabilities: "unconfigured" });
	});
});

describe("Orchestrator.triggerPipeline: named presets", () => {
	const pipeline: Pipeline = { name: "deploy", backend: "gh", steps: [{ jobName: "build" }, { jobName: "test" }] };

	it("runs all steps and reports success when every step succeeds", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				capabilities: Capability.Trigger,
				triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "1" },
				run: { id: "1", name: "run", status: "success", startedAt: new Date(0) },
			}),
		);
		orchestrator.registerPipeline(pipeline);

		const run = await orchestrator.triggerPipeline("deploy");
		expect(run.status).toBe("success");
		expect(run.steps).toHaveLength(2);
		expect(run.steps.every((step) => step.status === "success")).toBe(true);
		expect(orchestrator.getPipelineStatus("deploy")).toBe(run);
	});

	it("stops at the first failing step and does not run later steps", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				capabilities: Capability.Trigger,
				triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "1" },
				run: { id: "1", name: "run", status: "failure", startedAt: new Date(0) },
			}),
		);
		orchestrator.registerPipeline(pipeline);

		const run = await orchestrator.triggerPipeline("deploy");
		expect(run.status).toBe("failure");
		expect(run.steps[0]?.status).toBe("failure");
		expect(run.steps[1]?.status).toBe("running"); // never reached
	});

	it("fails immediately when the backend does not support triggering", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "gh" })); // no Trigger capability
		orchestrator.registerPipeline(pipeline);

		const run = await orchestrator.triggerPipeline("deploy");
		expect(run.status).toBe("failure");
	});

	it("merges per-invocation overrideParams onto every step's own baked-in params, override winning on key collision", async () => {
		const orchestrator = new Orchestrator();
		const backend = createStubCIBackend({
			name: "gh",
			capabilities: Capability.Trigger,
			triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "1" },
			run: { id: "1", name: "run", status: "success", startedAt: new Date(0) },
		});
		orchestrator.addAdapter(backend);
		orchestrator.registerPipeline({
			name: "deploy-with-params",
			backend: "gh",
			steps: [{ jobName: "build", params: { ENV: "stage", REGION: "us-east" } }],
		});

		await orchestrator.triggerPipeline("deploy-with-params", { ENV: "prod" });

		expect(backend.calls.trigger).toEqual([{ jobRef: "build", params: { ENV: "prod", REGION: "us-east" } }]);
	});

	it("applies overrideParams to every step of a multi-step pipeline, not just the first", async () => {
		const orchestrator = new Orchestrator();
		const backend = createStubCIBackend({
			name: "gh",
			capabilities: Capability.Trigger,
			triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "1" },
			run: { id: "1", name: "run", status: "success", startedAt: new Date(0) },
		});
		orchestrator.addAdapter(backend);
		orchestrator.registerPipeline(pipeline); // two steps: build, test -- neither has baked-in params

		await orchestrator.triggerPipeline("deploy", { VERSION: "4.20" });

		expect(backend.calls.trigger).toEqual([
			{ jobRef: "build", params: { VERSION: "4.20" } },
			{ jobRef: "test", params: { VERSION: "4.20" } },
		]);
	});

	it("behaves exactly as before when overrideParams is omitted -- backward compatible, not a breaking change", async () => {
		const orchestrator = new Orchestrator();
		const backend = createStubCIBackend({
			name: "gh",
			capabilities: Capability.Trigger,
			triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "1" },
			run: { id: "1", name: "run", status: "success", startedAt: new Date(0) },
		});
		orchestrator.addAdapter(backend);
		orchestrator.registerPipeline({ name: "deploy-with-params", backend: "gh", steps: [{ jobName: "build", params: { ENV: "stage" } }] });

		await orchestrator.triggerPipeline("deploy-with-params");

		expect(backend.calls.trigger).toEqual([{ jobRef: "build", params: { ENV: "stage" } }]);
	});
});

describe("Orchestrator.getVerdict: the compact real-time result", () => {
	it("returns an empty TestSummary on success, no failure context", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", run: { id: "9", name: "run", status: "success", startedAt: new Date(0) } }));

		const verdict = await orchestrator.getVerdict("gh", "job", undefined, {});
		expect(verdict.testSummary).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0 });
		expect(verdict.failure).toBeUndefined();
		expect(verdict.check.runId).toBe("latest"); // getRun was called with the explicit "latest" sentinel, not a silent guess
	});

	it("attaches a classified failure context on failure, using the real log", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				capabilities: Capability.Stages,
				run: { id: "9", name: "run", status: "failure", startedAt: new Date(0) },
				log: "Step 1 ok\nError: connection refused\n",
				stages: [{ id: "s1", name: "build", status: "success", startedAt: new Date(0) }, { id: "s2", name: "deploy", status: "failure", startedAt: new Date(0) }],
			}),
		);

		const verdict = await orchestrator.getVerdict("gh", "job", "9", {});
		expect(verdict.failure?.classification).toBe("network_timeout");
		expect(verdict.failure?.canRetry).toBe(true);
		expect(verdict.failure?.failedJob).toBe("deploy");
	});

	it("carries the backend's web URL through onto the check, for both the latest and an explicit runId", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({ name: "gh", run: { id: "9", name: "run", status: "success", startedAt: new Date(0), url: "https://ci.example/gh/job/9" } }),
		);

		const latest = await orchestrator.getVerdict("gh", "job", undefined, {});
		expect(latest.check.url).toBe("https://ci.example/gh/job/9");

		const explicit = await orchestrator.getVerdict("gh", "job", "9", {});
		expect(explicit.check.url).toBe("https://ci.example/gh/job/9");
	});

	it("honors an explicit runId rather than silently checking latest", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				runsById: {
					A: { id: "A", name: "run", status: "success", startedAt: new Date(0) },
					B: { id: "B", name: "run", status: "failure", startedAt: new Date(0) },
				},
			}),
		);

		const verdictA = await orchestrator.getVerdict("gh", "job", "A", {});
		const verdictB = await orchestrator.getVerdict("gh", "job", "B", {});
		expect(verdictA.check.status).toBe("success");
		expect(verdictB.check.status).toBe("failure");
	});
});

describe("Orchestrator.ciWatch: real-time progress", () => {
	it("computes progress percent and overdue against the estimated duration", async () => {
		const orchestrator = new Orchestrator();
		const run: CIRun = { id: "1", name: "run", status: "running", startedAt: new Date(0), durationMs: 60_000 };
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", capabilities: Capability.Trigger, run, estimatedDurationMs: 120_000 }));

		const watch = await orchestrator.ciWatch("gh", "job", "1");
		expect(watch.progressPercent).toBe(50);
		expect(watch.overdue).toBe(false);
	});

	it("flags overdue once elapsed exceeds 1.5x the estimate", async () => {
		const orchestrator = new Orchestrator();
		const run: CIRun = { id: "1", name: "run", status: "running", startedAt: new Date(0), durationMs: 200_000 };
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", capabilities: Capability.Trigger, run, estimatedDurationMs: 100_000 }));

		const watch = await orchestrator.ciWatch("gh", "job", "1");
		expect(watch.overdue).toBe(true);
	});

	it("carries the backend's web URL through onto the watch status", async () => {
		const orchestrator = new Orchestrator();
		const run: CIRun = { id: "1", name: "run", status: "running", startedAt: new Date(0), url: "https://ci.example/gh/job/1" };
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", capabilities: Capability.Trigger, run }));

		const watch = await orchestrator.ciWatch("gh", "job", "1");
		expect(watch.url).toBe("https://ci.example/gh/job/1");
	});
});

describe("Orchestrator: trigger records ownership; cancel is ownership-gated", () => {
	it("refuses to cancel a run this session never triggered", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", capabilities: Capability.Trigger }));
		await expect(orchestrator.ciCancel("gh", "job", "999")).rejects.toThrow(NotOwnedError);
	});

	it("allows cancel after ciTrigger records ownership for that run", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				capabilities: Capability.Trigger,
				triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "42" },
			}),
		);

		const result = await orchestrator.ciTrigger("gh", "job", {});
		expect(result.buildNumber).toBe("42");
		expect(orchestrator.ownsRun("gh", "42")).toBe(true);
		await expect(orchestrator.ciCancel("gh", "job", "42")).resolves.toBeUndefined();
	});

	it("fetches and attaches the backend's web URL once trigger resolves a runId", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				capabilities: Capability.Trigger,
				triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "42" },
				run: { id: "42", name: "run", status: "running", startedAt: new Date(0), url: "https://ci.example/gh/job/42" },
			}),
		);

		const result = await orchestrator.ciTrigger("gh", "job", {});
		expect(result.url).toBe("https://ci.example/gh/job/42");
	});

	it("leaves url undefined, without throwing, when the just-triggered run isn't queryable yet", async () => {
		const orchestrator = new Orchestrator();
		const backend = createStubCIBackend({
			name: "gh",
			capabilities: Capability.Trigger,
			triggerReceipt: { needsResolve: false, backend: "gh", jobRef: "job", runId: "43" },
		});
		// Trigger itself must still succeed -- only the follow-up getRun (fetching the URL) fails here.
		backend.getRun = async () => {
			throw new Error("not found yet");
		};
		orchestrator.addAdapter(backend);

		const result = await orchestrator.ciTrigger("gh", "job", {});
		expect(result.buildNumber).toBe("43");
		expect(result.url).toBeUndefined();
	});

	it("throws CapabilityUnsupportedError when triggering an unsupported backend", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(createStubCIBackend({ name: "gh" }));
		await expect(orchestrator.ciTrigger("gh", "job", {})).rejects.toThrow(CapabilityUnsupportedError);
	});
});

describe("Orchestrator: preset registry CRUD", () => {
	it("registerPipeline is an upsert -- registering the same name again replaces it", () => {
		const orchestrator = new Orchestrator();
		orchestrator.registerPipeline({ name: "deploy", backend: "gh", steps: [{ jobName: "build" }] });
		orchestrator.registerPipeline({ name: "deploy", backend: "gitlab", steps: [{ jobName: "release" }] });

		expect(orchestrator.getPipelineDefinition("deploy")).toEqual({ name: "deploy", backend: "gitlab", steps: [{ jobName: "release" }] });
		expect(orchestrator.listPipelineDefinitions()).toHaveLength(1);
	});

	it("getPipelineDefinition returns undefined for an unregistered name, not a throw", () => {
		const orchestrator = new Orchestrator();
		expect(orchestrator.getPipelineDefinition("missing")).toBeUndefined();
	});

	it("listPipelineDefinitions returns every registered preset's full definition", () => {
		const orchestrator = new Orchestrator();
		orchestrator.registerPipeline({ name: "a", backend: "gh", steps: [{ jobName: "x" }] });
		orchestrator.registerPipeline({ name: "b", backend: "gitlab", steps: [{ jobName: "y" }] });

		expect(orchestrator.listPipelineDefinitions()).toEqual([
			{ name: "a", backend: "gh", steps: [{ jobName: "x" }] },
			{ name: "b", backend: "gitlab", steps: [{ jobName: "y" }] },
		]);
	});

	it("unregisterPipeline returns true and removes an existing preset", () => {
		const orchestrator = new Orchestrator();
		orchestrator.registerPipeline({ name: "deploy", backend: "gh", steps: [{ jobName: "build" }] });

		expect(orchestrator.unregisterPipeline("deploy")).toBe(true);
		expect(orchestrator.getPipelineDefinition("deploy")).toBeUndefined();
		expect(orchestrator.listPipelineDefinitions()).toEqual([]);
	});

	it("unregisterPipeline is idempotent -- returns false for a name that was never registered", () => {
		const orchestrator = new Orchestrator();
		expect(orchestrator.unregisterPipeline("never-existed")).toBe(false);
	});
});

describe("Orchestrator.ciParamsTruncated", () => {
	it("truncates values over 500 chars and reports which keys were truncated", async () => {
		const orchestrator = new Orchestrator();
		const longValue = "x".repeat(600);
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", capabilities: Capability.History, runParams: { SHORT: "ok", LONG: longValue } }));

		const { params, truncatedKeys } = await orchestrator.ciParamsTruncated("gh", "job", "1");
		expect(params.SHORT).toBe("ok");
		expect(params.LONG?.length).toBe(503); // 500 chars + "..."
		expect(truncatedKeys).toEqual(["LONG"]);
	});
});

describe("Orchestrator.ciChain: recursive build tree", () => {
	it("expands children up to the given depth and stops at 0", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				runsById: {
					root: { id: "root", name: "root", status: "success", startedAt: new Date(0), children: [{ jobRef: "child", runId: "c1" }] },
					c1: { id: "c1", name: "child", status: "success", startedAt: new Date(0) },
				},
			}),
		);

		const expanded = await orchestrator.ciChain("gh", "job", "root", -1, false);
		expect(expanded.children).toHaveLength(1);
		expect(expanded.children?.[0]?.runId).toBe("c1");

		const shallow = await orchestrator.ciChain("gh", "job", "root", 0, false);
		expect(shallow.children).toBeUndefined();
	});

	it("never infinite-loops on a cycle, even with depth=-1 (unlimited)", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				runsById: {
					a: { id: "a", name: "a", status: "success", startedAt: new Date(0), children: [{ jobRef: "job", runId: "b" }] },
					b: { id: "b", name: "b", status: "success", startedAt: new Date(0), children: [{ jobRef: "job", runId: "a" }] },
				},
			}),
		);

		const result = await Promise.race([
			orchestrator.ciChain("gh", "job", "a", -1, false),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out -- likely an infinite loop")), 2000)),
		]);

		// a -> b -> a: the second "a" is already seen, so b's children list comes back empty, not another "a" node.
		expect(result.runId).toBe("a");
		expect(result.children).toHaveLength(1);
		expect(result.children?.[0]?.runId).toBe("b");
		expect(result.children?.[0]?.children ?? []).toHaveLength(0);
	});

	it("stops expanding once the hard node cap is hit, regardless of depth", async () => {
		const orchestrator = new Orchestrator();
		const runsById: Record<string, ReturnType<typeof makeChainRun>> = {};
		// A long chain of 500 distinct runs -- well past CHAIN_CRAWL_MAX_NODES (200) -- linked one to the next.
		for (let i = 0; i < 500; i++) {
			runsById[String(i)] = makeChainRun(i, i + 1 < 500 ? [{ jobRef: "job", runId: String(i + 1) }] : []);
		}
		orchestrator.addAdapter(createStubCIBackend({ name: "gh", runsById }));

		const result = await orchestrator.ciChain("gh", "job", "0", -1, false);

		let count = 0;
		const countNodes = (node: typeof result): void => {
			count++;
			for (const child of node.children ?? []) countNodes(child);
		};
		countNodes(result);
		expect(count).toBeLessThanOrEqual(200);
	});

	it("supplements run.children with a CIChainable backend's own downstream lookup", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gl",
				capabilities: Capability.Chain,
				runsById: { root: { id: "root", name: "root", status: "success", startedAt: new Date(0) } },
				downstreamRuns: [{ id: "d1", name: "downstream", status: "success", startedAt: new Date(0) }],
			}),
		);

		const expanded = await orchestrator.ciChain("gl", "job", "root", -1, false);

		expect(expanded.children).toHaveLength(1);
		expect(expanded.children?.[0]?.runId).toBe("d1");
	});

	it("a failed downstream lookup does not fail the whole tree", async () => {
		const orchestrator = new Orchestrator();
		const backend = createStubCIBackend({
			name: "gl",
			capabilities: Capability.Chain,
			runsById: { root: { id: "root", name: "root", status: "success", startedAt: new Date(0) } },
		});
		(backend as unknown as { getDownstreamRuns: () => Promise<never> }).getDownstreamRuns = async () => {
			throw new Error("bridges API unreachable");
		};
		orchestrator.addAdapter(backend);

		const expanded = await orchestrator.ciChain("gl", "job", "root", -1, false);

		expect(expanded.runId).toBe("root");
		expect(expanded.children).toBeUndefined();
	});
});

function makeChainRun(id: number, children: Array<{ jobRef: string; runId: string }>) {
	return { id: String(id), name: `run-${id}`, status: "success" as const, startedAt: new Date(0), children };
}

describe("Orchestrator.ciArtifactTree: flat list to directory tree", () => {
	it("groups artifacts by path segments", async () => {
		const orchestrator = new Orchestrator();
		orchestrator.addAdapter(
			createStubCIBackend({
				name: "gh",
				capabilities: Capability.Artifacts,
				artifacts: [
					{ name: "report.xml", path: "reports/report.xml" },
					{ name: "top.txt", path: "top.txt" },
				],
			}),
		);

		const tree = await orchestrator.ciArtifactTree("gh", "job", "1");
		expect(tree.files?.[0]?.name).toBe("top.txt");
		expect(tree.children?.[0]?.path).toBe("reports");
		expect(tree.children?.[0]?.files?.[0]?.name).toBe("report.xml");
	});
});

describe("applyLogFilter", () => {
	it("defaults to the last 200 lines when no grep and no explicit tail", () => {
		const raw = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n");
		const result = applyLogFilter(raw, {});
		expect(result.lines).toHaveLength(200);
		expect(result.totalLines).toBe(250);
		expect(result.truncated).toBe(true);
		expect(result.lines[0]).toBe("line 50");
	});

	it("widens to unlimited tail when grep is set but no explicit tail is given", () => {
		const raw = ["match 1", ...Array.from({ length: 300 }, (_, i) => `noise ${i}`), "match 2"].join("\n");
		const result = applyLogFilter(raw, { grep: "match" });
		expect(result.lines).toEqual(["match 1", "match 2"]);
		expect(result.filtered).toBe(true);
	});

	it("falls back to a literal case-insensitive substring match for invalid regexp", () => {
		const raw = "line with [unclosed bracket pattern\nother line";
		const result = applyLogFilter(raw, { grep: "[unclosed" });
		expect(result.lines).toEqual(["line with [unclosed bracket pattern"]);
	});

	it("applies a byte cap that trims from the front after tailing", () => {
		const longLine = "x".repeat(1000);
		const raw = Array.from({ length: 100 }, () => longLine).join("\n"); // ~100KB, over the 50KB cap
		const result = applyLogFilter(raw, { tail: -1 });
		const totalBytes = result.lines.reduce((sum, line) => sum + line.length + 1, 0);
		expect(totalBytes).toBeLessThanOrEqual(50 * 1024);
		expect(result.truncated).toBe(true);
	});
});

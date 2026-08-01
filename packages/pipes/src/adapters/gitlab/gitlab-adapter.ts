/**
 * GitLab CI adapter. Constructing this performs no network I/O —
 * connectivity is only ever exercised by the first real operation call.
 * GitLab assigns a pipeline ID synchronously on create, unlike GitHub's
 * async workflow_dispatch or Jenkins' queue — trigger never needs a
 * resolve loop here.
 */
import type { BuildFilter, CIArtifact, CIJob, CIRun, CIStageNode } from "../../domain/ci-run.ts";
import type { TriggerReceipt } from "../../domain/trigger.ts";
import {
	Capability,
	type CapabilitySet,
	type CIArtifactStore,
	type CIBackend,
	type CIChainable,
	type CIHistorical,
	type CIPipeliner,
	type CITriggerable,
} from "../../ports/ci-backend.ts";
import type { FetchLike } from "../github/auth.ts";
import { parseRateLimitHeaders, parseRetryAfterMs, RateLimitError } from "../http-rate-limit.ts";
import { withTimeout } from "../http-timeout.ts";

export class GitLabNotFoundError extends Error {
	constructor(path: string) {
		super(`GitLab: not found: ${path}`);
	}
}

export class GitLabApiError extends Error {
	constructor(method: string, path: string, status: number, body: string) {
		super(`GitLab API error: ${method} ${path}: ${status}: ${body}`);
	}
}

export interface GitLabAdapterOptions {
	name: string;
	baseUrl: string;
	/** Numeric project ID or URL-encoded path (e.g. "group%2Fproject") — GitLab's API accepts either. */
	projectId: string;
	token?: string;
	/** Resolved fresh before every request; takes precedence over `token` when present so a rotated/refreshed credential is always picked up. */
	getToken?: () => Promise<string | undefined>;
	fetchImpl?: FetchLike;
}

export function createGitLabAdapter(
	options: GitLabAdapterOptions,
): CIBackend & CITriggerable & CIHistorical & CIPipeliner & CIArtifactStore & CIChainable {
	const { name, projectId, token } = options;
	const apiBaseUrl = `${options.baseUrl.replace(/\/$/, "")}/api/v4`;
	// A caller-supplied fetchImpl (tests, or a future custom transport) is used as-is; the real
	// default fetch is wrapped so a stalled connection to GitLab can't hang ci.wait's poll loop forever.
	const doFetch = options.fetchImpl ?? withTimeout();
	const resolveToken = options.getToken ?? (async () => token);

	async function api<T>(method: string, path: string, body?: unknown): Promise<T | undefined> {
		const bearer = await resolveToken();
		const response = await doFetch(`${apiBaseUrl}${path}`, {
			method,
			headers: {
				...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
				accept: "application/json",
				...(body ? { "content-type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
		});

		if (response.status === 404) throw new GitLabNotFoundError(path);
		if (response.status === 429) {
			const info = parseRateLimitHeaders(response.headers);
			throw new RateLimitError(name, parseRetryAfterMs(response.headers.get("retry-after")), info);
		}
		if (!response.ok) throw new GitLabApiError(method, path, response.status, await response.text());
		if (response.status === 204) return undefined;
		const text = await response.text();
		return text ? (JSON.parse(text) as T) : undefined;
	}

	async function fetchRaw(path: string): Promise<Response> {
		const bearer = await resolveToken();
		return doFetch(`${apiBaseUrl}${path}`, { headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } });
	}

	function mapStatus(status: string): CIRun["status"] {
		switch (status) {
			case "success":
				return "success";
			case "failed":
				return "failure";
			case "canceled":
			case "skipped":
				return "aborted";
			case "running":
				return "running";
			case "pending":
			case "created":
			case "waiting_for_resource":
			case "preparing":
			case "scheduled":
				return "pending";
			default:
				return "pending";
		}
	}

	function mapResult(status: string): CIRun["result"] {
		switch (status) {
			case "success":
				return "SUCCESS";
			case "failed":
				return "FAILURE";
			case "canceled":
			case "skipped":
				return "ABORTED";
			default:
				return "";
		}
	}

	function toCIRun(pipeline: GlPipeline): CIRun {
		return {
			id: String(pipeline.id),
			name: pipeline.ref,
			status: mapStatus(pipeline.status),
			result: mapResult(pipeline.status),
			url: pipeline.web_url,
			startedAt: new Date(pipeline.created_at),
			durationMs: pipeline.duration ? pipeline.duration * 1000 : undefined,
		};
	}

	/** GitLab has no single "latest pipeline" endpoint by job ref; list newest-first and take the head. */
	async function fetchLatestPipeline(): Promise<GlPipeline> {
		const page = await api<GlPipeline[]>("GET", `/projects/${projectId}/pipelines?order_by=id&sort=desc&per_page=1`);
		const pipeline = page?.[0];
		if (!pipeline) throw new GitLabNotFoundError(`/projects/${projectId}/pipelines (latest)`);
		return pipeline;
	}

	/** GitLab jobs are already flat (no stage/step nesting like Jenkins' wfapi) — each job becomes one stage node with itself as its only step. */
	async function buildStageNodes(runId: string): Promise<CIStageNode[]> {
		const jobs = (await api<GlJob[]>("GET", `/projects/${projectId}/pipelines/${runId}/jobs`)) ?? [];
		return jobs.map((job) => ({
			id: String(job.id),
			name: job.stage,
			status: mapStatus(job.status),
			durationMs: job.duration ? job.duration * 1000 : undefined,
			steps: [
				{ id: String(job.id), name: job.name, status: mapStatus(job.status), durationMs: job.duration ? job.duration * 1000 : undefined },
			],
		}));
	}

	return {
		name: () => name,
		type: () => "gitlab",
		capabilities: (): CapabilitySet =>
			Capability.Trigger | Capability.History | Capability.Stages | Capability.Artifacts | Capability.Chain,

		/** "latest" is an explicit sentinel routed to a dedicated query; any other runId always fetches that exact pipeline, never a substitute. */
		async getRun(_jobRef: string, runId: string): Promise<CIRun> {
			if (runId === "latest") return toCIRun(await fetchLatestPipeline());
			const pipeline = await api<GlPipeline>("GET", `/projects/${projectId}/pipelines/${runId}`);
			if (!pipeline) throw new GitLabNotFoundError(`/projects/${projectId}/pipelines/${runId}`);
			return toCIRun(pipeline);
		},

		async searchRuns(_jobRef: string, filter: BuildFilter): Promise<CIRun[]> {
			const limit = filter.limit && filter.limit > 0 ? filter.limit : 20;
			const params = new URLSearchParams({ per_page: String(Math.max(limit * 3, 50)), order_by: "id", sort: "desc" });
			if (filter.result) params.set("status", glStatusForResult(filter.result));
			if (filter.runner) params.set("username", filter.runner);

			const pipelines = (await api<GlPipeline[]>("GET", `/projects/${projectId}/pipelines?${params}`)) ?? [];
			let runs = pipelines.map(toCIRun);
			if (filter.since) runs = runs.filter((run) => run.startedAt >= (filter.since as Date));
			return runs.slice(0, limit);
		},

		/** GitLab has no single pipeline-level log; concatenates each job's trace, matching GitHub's per-job approach for a consistent adapter shape. */
		async getLog(_jobRef: string, runId: string): Promise<string> {
			const jobs = (await api<GlJob[]>("GET", `/projects/${projectId}/pipelines/${runId}/jobs`)) ?? [];
			const sections = await Promise.all(
				jobs.map(async (job) => {
					const response = await fetchRaw(`/projects/${projectId}/jobs/${job.id}/trace`);
					if (!response.ok) return `--- ${job.name} (trace unavailable: HTTP ${response.status}) ---`;
					return `--- ${job.name} ---\n${await response.text()}`;
				}),
			);
			return sections.join("\n\n");
		},

		async cancelRun(_jobRef: string, runId: string): Promise<void> {
			await api("POST", `/projects/${projectId}/pipelines/${runId}/cancel`);
		},

		/** GitLab assigns a pipeline ID synchronously — never needs a resolve loop, unlike GitHub/Jenkins. */
		async trigger(jobRef: string, params: Record<string, string>): Promise<TriggerReceipt> {
			const ref = params.ref ?? jobRef ?? "main";
			const variables = Object.entries(params)
				.filter(([key]) => key !== "ref")
				.map(([key, value]) => ({ key, value }));
			const pipeline = await api<GlPipeline>("POST", `/projects/${projectId}/pipeline`, { ref, variables });
			if (!pipeline) throw new Error("GitLab pipeline create returned no body");
			return { backend: name, jobRef, needsResolve: false, runId: String(pipeline.id) };
		},

		async resolveReceipt(receipt: TriggerReceipt): Promise<TriggerReceipt> {
			return receipt; // already resolved synchronously by trigger()
		},

		async estimateDuration(): Promise<number> {
			return 0; // GitLab does not expose a per-project estimated pipeline duration
		},

		async listRuns(_jobRef: string, limit: number): Promise<CIRun[]> {
			const pipelines = (await api<GlPipeline[]>("GET", `/projects/${projectId}/pipelines?per_page=${limit}&order_by=id&sort=desc`)) ?? [];
			return pipelines.map(toCIRun);
		},

		async getRunParams(_jobRef: string, runId: string): Promise<Record<string, string>> {
			const variables = (await api<GlPipelineVariable[]>("GET", `/projects/${projectId}/pipelines/${runId}/variables`)) ?? [];
			const params: Record<string, string> = {};
			for (const variable of variables) params[variable.key] = variable.value;
			return params;
		},

		async listStages(_jobRef: string, runId: string): Promise<CIJob[]> {
			const jobs = (await api<GlJob[]>("GET", `/projects/${projectId}/pipelines/${runId}/jobs`)) ?? [];
			return jobs.map((job) => ({
				id: String(job.id),
				name: job.stage,
				status: mapStatus(job.status),
				startedAt: new Date(job.started_at ?? job.created_at),
				durationMs: job.duration ? job.duration * 1000 : undefined,
			}));
		},

		async listStageNodes(_jobRef: string, runId: string): Promise<CIStageNode[]> {
			return buildStageNodes(runId);
		},

		async listStageNodesWithLogs(_jobRef: string, runId: string): Promise<CIStageNode[]> {
			const nodes = await buildStageNodes(runId);
			for (const node of nodes) {
				const step = node.steps?.[0];
				if (step && step.status === "failure") {
					const response = await fetchRaw(`/projects/${projectId}/jobs/${step.id}/trace`);
					step.failedLog = response.ok ? await response.text() : undefined;
				}
			}
			return nodes;
		},

		async listArtifacts(_jobRef: string, runId: string): Promise<CIArtifact[]> {
			const jobs = (await api<GlJob[]>("GET", `/projects/${projectId}/pipelines/${runId}/jobs`)) ?? [];
			return jobs
				.filter((job) => job.artifacts && job.artifacts.length > 0)
				.flatMap((job) =>
					(job.artifacts ?? []).map((artifact) => ({
						name: artifact.filename,
						path: `${job.id}/${artifact.filename}`,
						sizeBytes: artifact.size,
					})),
				);
		},

		async getArtifact(_jobRef: string, _runId: string, path: string): Promise<Uint8Array> {
			const [jobId, ...rest] = path.split("/");
			const response = await fetchRaw(`/projects/${projectId}/jobs/${jobId}/artifacts/${rest.join("/")}`);
			if (response.status === 404) throw new GitLabNotFoundError(`artifact ${path}`);
			if (!response.ok) throw new GitLabApiError("GET", `artifact ${path}`, response.status, await response.text());
			return new Uint8Array(await response.arrayBuffer());
		},

		/**
		 * GitLab bridges are scoped to the parent pipeline itself, so downstreamJob/upstreamJob
		 * are informational only (matching conty's own GetDownstreamRuns) — the pipeline ID alone
		 * is enough to look up every direct downstream pipeline it triggered. Prefers trigger_jobs
		 * (the current endpoint name); bridges was deprecated in GitLab 19.2 but self-managed
		 * instances predating that release only have the old path, so a 404 falls back to it.
		 */
		async getDownstreamRuns(_downstreamJob: string, _upstreamJob: string, upstreamRunId: string): Promise<CIRun[]> {
			let bridges: GlTriggerJob[] | undefined;
			try {
				bridges = await api<GlTriggerJob[]>("GET", `/projects/${projectId}/pipelines/${upstreamRunId}/trigger_jobs?per_page=100`);
			} catch (error) {
				if (!(error instanceof GitLabNotFoundError)) throw error;
				bridges = await api<GlTriggerJob[]>("GET", `/projects/${projectId}/pipelines/${upstreamRunId}/bridges?per_page=100`);
			}
			return (bridges ?? [])
				.filter((bridge): bridge is GlTriggerJob & { downstream_pipeline: GlPipeline } => bridge.downstream_pipeline != null)
				.map((bridge) => toCIRun(bridge.downstream_pipeline));
		},
	};
}

function glStatusForResult(result: string): string {
	switch (result.toUpperCase()) {
		case "SUCCESS":
			return "success";
		case "FAILURE":
			return "failed";
		case "ABORTED":
			return "canceled";
		default:
			return result.toLowerCase();
	}
}

interface GlPipeline {
	id: number;
	ref: string;
	status: string;
	web_url: string;
	created_at: string;
	duration?: number;
}

interface GlJob {
	id: number;
	name: string;
	stage: string;
	status: string;
	created_at: string;
	started_at?: string;
	duration?: number;
	artifacts?: { filename: string; size: number }[];
}

interface GlPipelineVariable {
	key: string;
	value: string;
}

interface GlTriggerJob {
	downstream_pipeline: GlPipeline | null;
}

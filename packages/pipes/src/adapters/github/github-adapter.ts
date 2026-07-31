/**
 * GitHub Actions adapter. Constructing this performs no network I/O —
 * connectivity is only ever exercised by the first real operation call.
 */
import type { BuildFilter, CIArtifact, CIJob, CIRun, CIStageNode } from "../../domain/ci-run.ts";
import { isTerminalStatus } from "../../domain/ci-run.ts";
import type { RepoInfo, WorkflowInfo } from "../../domain/discovery.ts";
import type { TriggerReceipt } from "../../domain/trigger.ts";
import {
	Capability,
	type CapabilitySet,
	type CIArtifactStore,
	type CIBackend,
	type CIDiscoverable,
	type CIHistorical,
	type CIPipeliner,
	type CITriggerable,
} from "../../ports/ci-backend.ts";
import { parseRateLimitHeaders, parseRetryAfterMs, RateLimitError } from "../http-rate-limit.ts";
import { withTimeout } from "../http-timeout.ts";
import type { FetchLike } from "./auth.ts";

const API_BASE_URL = "https://api.github.com";

export class GitHubNotFoundError extends Error {
	constructor(path: string) {
		super(`GitHub: not found: ${path}`);
	}
}

export class GitHubApiError extends Error {
	constructor(method: string, path: string, status: number, body: string) {
		super(`GitHub API error: ${method} ${path}: ${status}: ${body}`);
	}
}

export interface GitHubAdapterOptions {
	name: string;
	owner: string;
	/**
	 * When given, this adapter is permanently bound to one repo -- jobRef stays
	 * a bare workflow file name ("publish.yml"), same as before this option
	 * became optional. When omitted, the adapter is account-scoped: every
	 * jobRef must be "repo/workflow.yml" instead, and repo is resolved fresh
	 * per call. Never both silently guessed at once -- an account-scoped
	 * adapter given a bare jobRef fails loudly (see resolveJobRef) rather than
	 * misrouting to some assumed repo.
	 */
	repo?: string;
	token?: string;
	/** Resolved fresh before every request; takes precedence over `token` when present so a rotated/refreshed credential is always picked up. */
	getToken?: () => Promise<string | undefined>;
	fetchImpl?: FetchLike;
}

export function createGitHubAdapter(options: GitHubAdapterOptions): CIBackend & CITriggerable & CIHistorical & CIPipeliner & CIArtifactStore & CIDiscoverable {
	const { name, owner, repo: fixedRepo, token } = options;
	// A caller-supplied fetchImpl (tests, or a future custom transport) is used as-is; the real
	// default fetch is wrapped so a stalled connection to GitHub can't hang ci.wait's poll loop forever.
	const doFetch = options.fetchImpl ?? withTimeout();
	const resolveToken = options.getToken ?? (async () => token);

	/**
	 * Resolves {repo, workflow} for one call. A repo-pinned adapter (fixedRepo
	 * set) treats the whole jobRef as the workflow name, unchanged from before
	 * this became configurable. An account-scoped adapter requires
	 * "repo/workflow.yml" and fails loudly on anything else -- a bare
	 * workflow name would otherwise have no repo to route to at all.
	 */
	function resolveJobRef(jobRef: string): { repo: string; workflow: string } {
		if (fixedRepo !== undefined) return { repo: fixedRepo, workflow: jobRef };
		const slash = jobRef.indexOf("/");
		if (slash <= 0 || slash === jobRef.length - 1) {
			throw new Error(`GitHub backend "${name}" is account-scoped -- jobRef must be "repo/workflow.yml", got: "${jobRef}"`);
		}
		return { repo: jobRef.slice(0, slash), workflow: jobRef.slice(slash + 1) };
	}

	async function api<T>(method: string, path: string, body?: unknown): Promise<T | undefined> {
		const bearer = await resolveToken();
		const response = await doFetch(`${API_BASE_URL}${path}`, {
			method,
			headers: {
				...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
				accept: "application/vnd.github+json",
				...(body ? { "content-type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
		});

		if (response.status === 404) throw new GitHubNotFoundError(path);
		if (response.status === 429 || response.status === 403) {
			const info = parseRateLimitHeaders(response.headers);
			if (info.remaining === 0 || response.status === 429) {
				throw new RateLimitError(name, parseRetryAfterMs(response.headers.get("retry-after")), info);
			}
		}
		if (!response.ok) {
			const text = await response.text();
			throw new GitHubApiError(method, path, response.status, text);
		}
		if (response.status === 204) return undefined;
		const text = await response.text();
		return text ? (JSON.parse(text) as T) : undefined;
	}

	async function fetchRaw(path: string): Promise<Response> {
		const bearer = await resolveToken();
		return doFetch(`${API_BASE_URL}${path}`, {
			headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), accept: "application/vnd.github+json" },
		});
	}

	function mapStatus(status: string, conclusion: string | null): CIRun["status"] {
		if (status === "completed") {
			switch (conclusion) {
				case "success":
					return "success";
				case "cancelled":
					return "aborted";
				case "failure":
				default:
					return "failure";
			}
		}
		if (status === "in_progress" || status === "queued") return "running";
		return "pending";
	}

	function mapResult(conclusion: string | null): CIRun["result"] {
		switch (conclusion) {
			case "success":
				return "SUCCESS";
			case "failure":
				return "FAILURE";
			case "cancelled":
				return "ABORTED";
			default:
				return "";
		}
	}

	/** GitHub exposes no duration field directly; a completed run's wall-clock span is `updated_at - run_started_at` (falling back to `created_at` if the run never queued). Still-running/pending runs keep durationMs undefined -- orchestrator.ciWatch derives their elapsed time from startedAt instead. */
	function toCIRun(run: GhWorkflowRun): CIRun {
		const status = mapStatus(run.status, run.conclusion);
		const startedAt = new Date(run.run_started_at ?? run.created_at);
		return {
			id: String(run.id),
			name: run.name ?? "",
			status,
			result: mapResult(run.conclusion),
			url: run.html_url,
			startedAt,
			durationMs: isTerminalStatus(status) && run.updated_at ? Math.max(0, new Date(run.updated_at).getTime() - startedAt.getTime()) : undefined,
		};
	}

	return {
		name: () => name,
		type: () => "github",
		capabilities: (): CapabilitySet => Capability.Trigger | Capability.History | Capability.Stages | Capability.Artifacts | Capability.Discover,

		/** "latest" is an explicit sentinel routed to a dedicated query; any other runId always fetches that exact run, never a substitute. */
		async getRun(jobRef: string, runId: string): Promise<CIRun> {
			const { repo } = resolveJobRef(jobRef);
			if (runId === "latest") {
				const page = await api<{ workflow_runs: GhWorkflowRun[] }>("GET", `/repos/${owner}/${repo}/actions/runs?per_page=1`);
				const run = page?.workflow_runs[0];
				if (!run) throw new GitHubNotFoundError(`/repos/${owner}/${repo}/actions/runs (latest)`);
				return toCIRun(run);
			}
			const run = await api<GhWorkflowRun>("GET", `/repos/${owner}/${repo}/actions/runs/${runId}`);
			if (!run) throw new GitHubNotFoundError(`/repos/${owner}/${repo}/actions/runs/${runId}`);
			return toCIRun(run);
		},

		async searchRuns(jobRef: string, filter: BuildFilter): Promise<CIRun[]> {
			const { repo } = resolveJobRef(jobRef);
			const limit = filter.limit && filter.limit > 0 ? filter.limit : 20;
			const params = new URLSearchParams({ per_page: String(Math.max(limit * 3, 50)) });
			if (filter.result) params.set("status", filter.result.toLowerCase());
			if (filter.runner) params.set("actor", filter.runner);

			const page = await api<{ workflow_runs: GhWorkflowRun[] }>("GET", `/repos/${owner}/${repo}/actions/runs?${params}`);
			const runs = (page?.workflow_runs ?? []).map(toCIRun);
			const filtered = filter.since ? runs.filter((run) => run.startedAt >= (filter.since as Date)) : runs;
			return filtered.slice(0, limit);
		},

		/**
		 * GitHub's run-level log endpoint returns a ZIP archive, not text —
		 * unlike Jenkins/GitLab. Fetches the job list for the run instead and
		 * concatenates each job's plain-text log (the per-job endpoint redirects
		 * to a temporary blob URL, which fetch follows transparently).
		 */
		async getLog(jobRef: string, runId: string): Promise<string> {
			const { repo } = resolveJobRef(jobRef);
			const jobsPage = await api<{ jobs: GhWorkflowJob[] }>("GET", `/repos/${owner}/${repo}/actions/runs/${runId}/jobs`);
			const jobs = jobsPage?.jobs ?? [];
			const sections = await Promise.all(
				jobs.map(async (job) => {
					const response = await fetchRaw(`/repos/${owner}/${repo}/actions/jobs/${job.id}/logs`);
					if (!response.ok) return `--- ${job.name} (log unavailable: HTTP ${response.status}) ---`;
					return `--- ${job.name} ---\n${await response.text()}`;
				}),
			);
			return sections.join("\n\n");
		},

		async cancelRun(jobRef: string, runId: string): Promise<void> {
			const { repo } = resolveJobRef(jobRef);
			await api("POST", `/repos/${owner}/${repo}/actions/runs/${runId}/cancel`);
		},

		async trigger(jobRef: string, params: Record<string, string>): Promise<TriggerReceipt> {
			const { repo, workflow } = resolveJobRef(jobRef);
			const body: { ref: string; inputs?: Record<string, string> } = { ref: params.ref ?? "main" };
			const inputs = { ...params };
			delete inputs.ref;
			if (Object.keys(inputs).length > 0) body.inputs = inputs;

			const dispatchedAt = new Date().toISOString();
			await api("POST", `/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, body);
			return { backend: name, jobRef, needsResolve: true, opaqueRef: dispatchedAt };
		},

		/** GitHub's workflow_dispatch has no run ID at trigger time; correlate by created_at against runs dispatched after the trigger timestamp. jobRef comes from the receipt trigger() itself produced, so it always carries the correct repo even for an account-scoped adapter. */
		async resolveReceipt(receipt: TriggerReceipt): Promise<TriggerReceipt> {
			if (!receipt.opaqueRef) return receipt;
			const { repo } = resolveJobRef(receipt.jobRef);
			const since = new Date(receipt.opaqueRef);
			const page = await api<{ workflow_runs: GhWorkflowRun[] }>(
				"GET",
				`/repos/${owner}/${repo}/actions/runs?event=workflow_dispatch&per_page=10`,
			);
			const match = (page?.workflow_runs ?? []).find((run) => new Date(run.created_at).getTime() > since.getTime() - 5_000);
			if (!match) return receipt; // not yet visible — caller polls again
			return { ...receipt, runId: String(match.id), needsResolve: false };
		},

		/** GitHub Actions exposes no estimated-duration field (unlike Jenkins' `lastBuild.estimatedDuration`) -- averages durationMs across the most recent completed runs of this workflow instead. */
		async estimateDuration(jobRef: string): Promise<number> {
			const { repo, workflow } = resolveJobRef(jobRef);
			const page = await api<{ workflow_runs: GhWorkflowRun[] }>(
				"GET",
				`/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?status=completed&per_page=10`,
			);
			const durations = (page?.workflow_runs ?? []).map((run) => toCIRun(run).durationMs).filter((ms): ms is number => typeof ms === "number" && ms > 0);
			if (durations.length === 0) return 0;
			return durations.reduce((sum, ms) => sum + ms, 0) / durations.length;
		},

		async listRuns(jobRef: string, limit: number): Promise<CIRun[]> {
			const { repo } = resolveJobRef(jobRef);
			const page = await api<{ workflow_runs: GhWorkflowRun[] }>("GET", `/repos/${owner}/${repo}/actions/runs?per_page=${limit}`);
			return (page?.workflow_runs ?? []).map(toCIRun);
		},

		async getRunParams(): Promise<Record<string, string>> {
			throw new Error("GitHub Actions workflow inputs are not retrievable after dispatch");
		},

		async listStages(jobRef: string, runId: string): Promise<CIJob[]> {
			const { repo } = resolveJobRef(jobRef);
			const page = await api<{ jobs: GhWorkflowJob[] }>("GET", `/repos/${owner}/${repo}/actions/runs/${runId}/jobs`);
			return (page?.jobs ?? []).map((job) => ({
				id: String(job.id),
				name: job.name,
				status: mapStatus(job.status, job.conclusion),
				result: mapResult(job.conclusion),
				startedAt: new Date(job.started_at ?? 0),
			}));
		},

		async listStageNodes(): Promise<CIStageNode[]> {
			throw new Error("GitHub Actions does not expose step-level pipeline detail through this adapter yet");
		},

		async listStageNodesWithLogs(): Promise<CIStageNode[]> {
			throw new Error("GitHub Actions does not expose step-level pipeline detail through this adapter yet");
		},

		async listArtifacts(jobRef: string, runId: string): Promise<CIArtifact[]> {
			const { repo } = resolveJobRef(jobRef);
			const page = await api<{ artifacts: GhArtifact[] }>("GET", `/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`);
			return (page?.artifacts ?? []).map((artifact) => ({ name: artifact.name, path: String(artifact.id), sizeBytes: artifact.size_in_bytes }));
		},

		async getArtifact(jobRef: string, _runId: string, path: string): Promise<Uint8Array> {
			const { repo } = resolveJobRef(jobRef);
			const response = await fetchRaw(`/repos/${owner}/${repo}/actions/artifacts/${path}/zip`);
			if (response.status === 404) throw new GitHubNotFoundError(`artifact ${path}`);
			if (!response.ok) throw new GitHubApiError("GET", `artifact ${path}`, response.status, await response.text());
			return new Uint8Array(await response.arrayBuffer());
		},

		/**
		 * /user/repos (not /users/{owner}/repos, which only ever returns public
		 * repos) so a private repo the token can see is still discoverable --
		 * covers both owner being the token's own login and an org it belongs
		 * to. Bounded to one page (100) -- an owner with more than that sees
		 * only the first 100, not a silent unbounded fetch.
		 */
		async listRepos(): Promise<RepoInfo[]> {
			const repos = await api<GhRepo[]>("GET", "/user/repos?per_page=100&affiliation=owner,collaborator,organization_member");
			return (repos ?? []).filter((r) => r.owner.login === owner).map((r) => ({ name: r.name, fullName: r.full_name, private: r.private }));
		},

		/** repo is always the caller-given value, never resolveJobRef'd -- this takes a bare repo name, not a jobRef. */
		async listWorkflows(repoArg: string): Promise<WorkflowInfo[]> {
			const page = await api<{ workflows: GhWorkflow[] }>("GET", `/repos/${owner}/${repoArg}/actions/workflows?per_page=100`);
			return (page?.workflows ?? []).map((w) => ({ name: w.name, fileName: w.path.split("/").pop() ?? w.path, state: w.state }));
		},
	};
}

interface GhWorkflowRun {
	id: number;
	name: string | null;
	status: string;
	conclusion: string | null;
	html_url: string;
	created_at: string;
	run_started_at?: string;
	updated_at?: string;
}

interface GhWorkflowJob {
	id: number;
	name: string;
	status: string;
	conclusion: string | null;
	started_at: string | null;
}

interface GhArtifact {
	id: number;
	name: string;
	size_in_bytes: number;
}

interface GhRepo {
	name: string;
	full_name: string;
	private: boolean;
	owner: { login: string };
}

interface GhWorkflow {
	name: string;
	path: string;
	state: string;
}

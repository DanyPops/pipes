/**
 * Jenkins adapter. Constructing this performs no network I/O — connectivity
 * is only ever exercised by the first real operation call, and the crumb
 * is fetched lazily on the first mutating request, not here.
 */
import type { BuildFilter, CIArtifact, CIJob, CIRun, CIStageNode, CIStep } from "../../domain/ci-run.ts";
import type { TriggerReceipt } from "../../domain/trigger.ts";
import { Capability, type CapabilitySet, type CIArtifactStore, type CIBackend, type CIChainable, type CIHistorical, type CIPipeliner, type CITriggerable } from "../../ports/ci-backend.ts";
import type { FetchLike } from "../github/auth.ts";
import { type CrumbCache, createCrumbCache, type JenkinsCredentials, withCrumbHeaders } from "./auth.ts";

export class JenkinsNotFoundError extends Error {
	constructor(path: string) {
		super(`Jenkins: not found: ${path}`);
	}
}

export class JenkinsApiError extends Error {
	constructor(method: string, path: string, status: number, body: string) {
		super(`Jenkins API error: ${method} ${path}: ${status}: ${body}`);
	}
}

export interface JenkinsAdapterOptions {
	name: string;
	credentials: JenkinsCredentials;
	fetchImpl?: FetchLike;
	crumbCache?: CrumbCache;
}

/** Turns "folder/subfolder/job" into Jenkins' URL path shape "job/folder/job/subfolder/job/job". */
function buildJobPath(jobRef: string): string {
	return jobRef
		.split("/")
		.filter(Boolean)
		.map((segment) => `job/${encodeURIComponent(segment)}`)
		.join("/");
}

/** "latest" is an explicit sentinel mapped to Jenkins' own lastBuild alias; any other runId is used verbatim, never substituted. */
function buildSelector(runId: string): string {
	return runId === "latest" ? "lastBuild" : runId;
}

function mapBuildStatus(building: boolean, result: string | null): CIRun["status"] {
	if (building) return "running";
	switch (result) {
		case "SUCCESS":
			return "success";
		case "ABORTED":
			return "aborted";
		case "FAILURE":
		case "UNSTABLE":
			return "failure";
		default:
			return "pending";
	}
}

function mapBuildResult(result: string | null): CIRun["result"] {
	switch (result) {
		case "SUCCESS":
			return "SUCCESS";
		case "FAILURE":
			return "FAILURE";
		case "UNSTABLE":
			return "UNSTABLE";
		case "ABORTED":
			return "ABORTED";
		default:
			return "";
	}
}

/** Maps Jenkins' wfapi stage/step status vocabulary (SUCCESS/FAILED/IN_PROGRESS/NOT_EXECUTED/...) onto the shared RunStatus. */
function mapPipelineStatus(status: string): CIRun["status"] {
	switch (status) {
		case "SUCCESS":
			return "success";
		case "FAILED":
			return "failure";
		case "IN_PROGRESS":
			return "running";
		case "NOT_EXECUTED":
		case "SKIPPED":
		case "PAUSED_PENDING_INPUT":
			return "pending";
		case "ABORTED":
			return "aborted";
		default:
			return "pending";
	}
}

export function createJenkinsAdapter(
	options: JenkinsAdapterOptions,
): CIBackend & CITriggerable & CIHistorical & CIPipeliner & CIArtifactStore & CIChainable {
	const { name, credentials } = options;
	const doFetch = options.fetchImpl ?? (fetch as unknown as FetchLike);
	const crumbCache = options.crumbCache ?? createCrumbCache();
	const baseUrl = credentials.baseUrl.replace(/\/$/, "");

	async function get<T>(path: string): Promise<T | undefined> {
		const response = await doFetch(`${baseUrl}/${path}`, { headers: { authorization: basicAuthHeaderFor(credentials) } });
		if (response.status === 404) throw new JenkinsNotFoundError(path);
		if (!response.ok) throw new JenkinsApiError("GET", path, response.status, await response.text());
		const text = await response.text();
		return text ? (JSON.parse(text) as T) : undefined;
	}

	function basicAuthHeaderFor(creds: JenkinsCredentials): string {
		return `Basic ${Buffer.from(`${creds.username}:${creds.apiToken}`).toString("base64")}`;
	}

	async function getText(path: string): Promise<string> {
		const response = await doFetch(`${baseUrl}/${path}`, { headers: { authorization: basicAuthHeaderFor(credentials) } });
		if (response.status === 404) throw new JenkinsNotFoundError(path);
		if (!response.ok) throw new JenkinsApiError("GET", path, response.status, await response.text());
		return response.text();
	}

	/** POST with a crumb attached; retries once with a freshly-fetched crumb if the first attempt is rejected as forbidden. */
	async function post(path: string, init: RequestInit = {}): Promise<Response> {
		const headers = await withCrumbHeaders(credentials, crumbCache, doFetch, init.headers as Record<string, string>);
		let response = await doFetch(`${baseUrl}/${path}`, { ...init, method: "POST", headers });
		if (response.status === 403) {
			crumbCache.set(undefined);
			const retryHeaders = await withCrumbHeaders(credentials, crumbCache, doFetch, init.headers as Record<string, string>);
			response = await doFetch(`${baseUrl}/${path}`, { ...init, method: "POST", headers: retryHeaders });
		}
		return response;
	}

	function toCIRun(jobRef: string, build: JenkinsBuild): CIRun {
		return {
			id: String(build.number),
			name: build.fullDisplayName ?? jobRef,
			status: mapBuildStatus(build.building, build.result),
			result: mapBuildResult(build.result),
			url: build.url,
			startedAt: new Date(build.timestamp ?? 0),
			durationMs: build.duration,
		};
	}

	async function fetchWfStages(jobRef: string, runId: string): Promise<WfStage[]> {
		const page = await get<{ stages: WfStage[] }>(`${buildJobPath(jobRef)}/${buildSelector(runId)}/wfapi/describe`);
		return page?.stages ?? [];
	}

	/**
	 * Hand-rolled minimal decode of the per-stage wfapi response rather than a
	 * full-fidelity typed client: this endpoint's stageFlowNodes shape has
	 * been observed to diverge from what generic Jenkins client libraries
	 * model (e.g. a field typed as a number array that the server actually
	 * sends as strings), so only the fields actually used are declared here.
	 */
	async function fetchStageSteps(jobRef: string, runId: string, stageId: string): Promise<CIStep[]> {
		const node = await get<{ stageFlowNodes?: WfStageFlowNode[] }>(`${buildJobPath(jobRef)}/${buildSelector(runId)}/execution/node/${stageId}/wfapi/describe`);
		return (node?.stageFlowNodes ?? []).map((step) => ({
			id: step.id,
			name: step.name,
			status: mapPipelineStatus(step.status),
			durationMs: step.durationMillis,
			description: firstNonBlankLine(step.parameterDescription) || step.name,
		}));
	}

	async function fetchStepLog(jobRef: string, runId: string, stepId: string): Promise<string | undefined> {
		try {
			const log = await get<{ text?: string }>(`${buildJobPath(jobRef)}/${buildSelector(runId)}/execution/node/${stepId}/wfapi/log`);
			return log?.text;
		} catch {
			return undefined;
		}
	}

	async function buildStageNodes(jobRef: string, runId: string): Promise<CIStageNode[]> {
		const stages = await fetchWfStages(jobRef, runId);
		const nodes: CIStageNode[] = [];
		for (const stage of stages) {
			const steps = stage.status === "NOT_EXECUTED" || stage.status === "SKIPPED" ? [] : await fetchStageSteps(jobRef, runId, stage.id);
			nodes.push({ id: stage.id, name: stage.name, status: mapPipelineStatus(stage.status), durationMs: stage.durationMillis, steps });
		}
		return nodes;
	}

	return {
		name: () => name,
		type: () => "jenkins",
		capabilities: (): CapabilitySet => Capability.Trigger | Capability.History | Capability.Stages | Capability.Artifacts | Capability.Chain,

		async getRun(jobRef: string, runId: string): Promise<CIRun> {
			const path = `${buildJobPath(jobRef)}/${buildSelector(runId)}/api/json?tree=number,result,building,timestamp,duration,estimatedDuration,url,fullDisplayName,description`;
			const build = await get<JenkinsBuild>(path);
			if (!build) throw new JenkinsNotFoundError(path);
			return toCIRun(jobRef, build);
		},

		async searchRuns(jobRef: string, filter: BuildFilter): Promise<CIRun[]> {
			const limit = filter.limit && filter.limit > 0 ? filter.limit : 20;
			const fetchCount = Math.max(limit * 3, 50);
			// tree= requires every nested field enumerated explicitly, or it is silently omitted, not errored.
			const tree = `builds[number,result,building,timestamp,duration,url,fullDisplayName,actions[parameters[name,value],causes[userId,userName]]]{0,${fetchCount}}`;
			const page = await get<{ builds: JenkinsBuild[] }>(`${buildJobPath(jobRef)}/api/json?tree=${encodeURIComponent(tree)}`);
			let builds = (page?.builds ?? []).map((build) => toCIRun(jobRef, build));

			if (filter.result) builds = builds.filter((run) => run.result === filter.result);
			if (filter.since) builds = builds.filter((run) => run.startedAt >= (filter.since as Date));
			if (filter.runner) {
				const runnerIds = (page?.builds ?? []).map((build) => causesMatch(build, filter.runner as string));
				builds = builds.filter((_run, index) => runnerIds[index]);
			}
			return builds.slice(0, limit);
		},

		async getLog(jobRef: string, runId: string): Promise<string> {
			return getText(`${buildJobPath(jobRef)}/${buildSelector(runId)}/consoleText`);
		},

		async cancelRun(jobRef: string, runId: string): Promise<void> {
			await post(`${buildJobPath(jobRef)}/${runId}/stop`);
		},

		async trigger(jobRef: string, params: Record<string, string>): Promise<TriggerReceipt> {
			const hasParams = Object.keys(params).length > 0;
			const path = hasParams ? `${buildJobPath(jobRef)}/buildWithParameters?${new URLSearchParams(params)}` : `${buildJobPath(jobRef)}/build`;
			const response = await post(path);
			if (!response.ok && response.status !== 201) {
				throw new JenkinsApiError("POST", path, response.status, await response.text());
			}
			const location = response.headers.get("location");
			if (!location) throw new Error("Jenkins trigger response missing Location header (queue item URL)");
			return { backend: name, jobRef, needsResolve: true, opaqueRef: location };
		},

		/** The queue item URL from trigger() is polled until it gains an `executable`, at which point the real build number is known. */
		async resolveReceipt(receipt: TriggerReceipt): Promise<TriggerReceipt> {
			if (!receipt.opaqueRef) return receipt;
			const queueUrl = receipt.opaqueRef.replace(/\/$/, "");
			const item = await get<{ cancelled?: boolean; executable?: { number: number } }>(`${queueUrl.replace(baseUrl, "").replace(/^\//, "")}/api/json`);
			if (item?.cancelled) throw new Error(`Jenkins queue item was cancelled: ${receipt.opaqueRef}`);
			if (item?.executable) return { ...receipt, runId: String(item.executable.number), needsResolve: false };
			return receipt;
		},

		async estimateDuration(jobRef: string): Promise<number> {
			const build = await get<{ estimatedDuration?: number }>(`${buildJobPath(jobRef)}/lastBuild/api/json?tree=estimatedDuration`);
			return build?.estimatedDuration ?? 0;
		},

		async listRuns(jobRef: string, limit: number): Promise<CIRun[]> {
			const tree = `builds[number,result,building,timestamp,duration,url,fullDisplayName]{0,${limit}}`;
			const page = await get<{ builds: JenkinsBuild[] }>(`${buildJobPath(jobRef)}/api/json?tree=${encodeURIComponent(tree)}`);
			return (page?.builds ?? []).map((build) => toCIRun(jobRef, build));
		},

		async getRunParams(jobRef: string, runId: string): Promise<Record<string, string>> {
			const build = await get<JenkinsBuildWithActions>(
				`${buildJobPath(jobRef)}/${buildSelector(runId)}/api/json?tree=actions[parameters[name,value]]`,
			);
			const params: Record<string, string> = {};
			for (const action of build?.actions ?? []) {
				for (const parameter of action.parameters ?? []) {
					params[parameter.name] = String(parameter.value);
				}
			}
			return params;
		},

		async listStages(jobRef: string, runId: string): Promise<CIJob[]> {
			const stages = await fetchWfStages(jobRef, runId);
			return stages.map((stage) => ({
				id: stage.id,
				name: stage.name,
				status: mapPipelineStatus(stage.status),
				startedAt: new Date(stage.startTimeMillis ?? 0),
				durationMs: stage.durationMillis,
			}));
		},

		async listStageNodes(jobRef: string, runId: string): Promise<CIStageNode[]> {
			return buildStageNodes(jobRef, runId);
		},

		async listStageNodesWithLogs(jobRef: string, runId: string): Promise<CIStageNode[]> {
			const nodes = await buildStageNodes(jobRef, runId);
			for (const node of nodes) {
				for (const step of node.steps ?? []) {
					if (step.status === "failure") step.failedLog = await fetchStepLog(jobRef, runId, step.id);
				}
			}
			return nodes;
		},

		async listArtifacts(jobRef: string, runId: string): Promise<CIArtifact[]> {
			const page = await get<{ artifacts: JenkinsArtifact[] }>(
				`${buildJobPath(jobRef)}/${buildSelector(runId)}/api/json?tree=artifacts[fileName,relativePath]`,
			);
			return (page?.artifacts ?? []).map((artifact) => ({ name: artifact.fileName, path: normalizeArtifactPath(artifact.relativePath, artifact.fileName) }));
		},

		async getArtifact(jobRef: string, runId: string, path: string): Promise<Uint8Array> {
			const response = await doFetch(`${baseUrl}/${buildJobPath(jobRef)}/${buildSelector(runId)}/artifact/${path}`, {
				headers: { authorization: basicAuthHeaderFor(credentials) },
			});
			if (response.status === 404) throw new JenkinsNotFoundError(`artifact ${path}`);
			if (!response.ok) throw new JenkinsApiError("GET", `artifact ${path}`, response.status, await response.text());
			return new Uint8Array(await response.arrayBuffer());
		},

		/**
		 * Jenkins has no reverse index from an upstream build to the downstream builds it
		 * triggered, so this scans downstreamJob's recent builds (bounded to the last 50 via
		 * Jenkins' own tree range syntax, not an open-ended fetch) and keeps only the ones whose
		 * cause chain names this exact upstream project+build number -- the real, plugin-free
		 * mechanism (hudson.model.Cause$UpstreamCause), not conty's fragile description-HTML-
		 * anchor-parsing hack, which only works if a job manually writes links into its own
		 * description.
		 */
		async getDownstreamRuns(downstreamJob: string, upstreamJob: string, upstreamRunId: string): Promise<CIRun[]> {
			const upstreamBuildNumber = Number(upstreamRunId);
			if (!Number.isInteger(upstreamBuildNumber)) throw new Error(`invalid upstream run id: ${upstreamRunId}`);

			const treeParam =
				"builds[number,result,fullDisplayName,timestamp,duration,url,building," +
				"actions[causes[upstreamBuild,upstreamProject]]]{0,50}";
			const page = await get<{ builds: JenkinsBuild[] }>(`${buildJobPath(downstreamJob)}/api/json?tree=${treeParam}`);

			return (page?.builds ?? [])
				.filter((build) =>
					(build.actions ?? []).some((action) =>
						(action.causes ?? []).some(
							(cause) => cause.upstreamBuild === upstreamBuildNumber && cause.upstreamProject?.toLowerCase() === upstreamJob.toLowerCase(),
						),
					),
				)
				.map((build) => toCIRun(downstreamJob, build));
		},
	};
}

/** Defensive: Jenkins' core artifact API already returns a clean relativePath, but strip a stray leading slash if one ever appears. */
function normalizeArtifactPath(relativePath: string, fallback: string): string {
	if (!relativePath) return fallback;
	return relativePath.startsWith("/") ? relativePath.slice(1) : relativePath;
}

function firstNonBlankLine(text: string | undefined): string {
	if (!text) return "";
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) return trimmed;
	}
	return "";
}

function causesMatch(build: JenkinsBuild, runner: string): boolean {
	for (const action of build.actions ?? []) {
		for (const cause of action.causes ?? []) {
			if (cause.userId === runner || cause.userName === runner) return true;
		}
	}
	return false;
}

interface JenkinsBuild {
	number: number;
	result: string | null;
	building: boolean;
	timestamp?: number;
	duration?: number;
	url: string;
	fullDisplayName?: string;
	actions?: JenkinsBuildAction[];
}

interface JenkinsBuildAction {
	parameters?: { name: string; value: unknown }[];
	/** Cause objects are polymorphic in Jenkins' API: userId/userName come from UserIdCause, upstreamProject/upstreamBuild from UpstreamCause -- both can appear in the same causes array. */
	causes?: { userId?: string; userName?: string; upstreamProject?: string; upstreamBuild?: number }[];
}

interface JenkinsBuildWithActions {
	actions?: { parameters?: { name: string; value: unknown }[] }[];
}

interface JenkinsArtifact {
	fileName: string;
	relativePath: string;
}

interface WfStage {
	id: string;
	name: string;
	status: string;
	startTimeMillis?: number;
	durationMillis?: number;
}

interface WfStageFlowNode {
	id: string;
	name: string;
	status: string;
	durationMillis?: number;
	parameterDescription?: string;
}

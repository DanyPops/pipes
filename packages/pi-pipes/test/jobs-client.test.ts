import { afterEach, describe, expect, it } from "bun:test";
import { fetchSubscribedJobs, resetJobsClientConnectorForTests, setJobsClientConnectorForTests } from "../src/jobs-client.ts";

describe("fetchSubscribedJobs", () => {
	afterEach(resetJobsClientConnectorForTests);

	it("maps ci.subscribed's RunSnapshot-shaped runs to JobsWidgetRow", async () => {
		setJobsClientConnectorForTests(
			() =>
				({
					async call() {
						return {
							runs: [
								{
									backend: "jenkins-auto",
									jobRef: "ocp-baremetal-ipi-deployment",
									runId: "40531",
									status: "running",
									result: "",
									url: "https://jenkins.example/40531",
									startedAt: new Date(0),
									fetchedAt: new Date(0),
									watched: true,
									progressPercent: 42,
									estimatedMs: 100_000,
									overdue: false,
								},
							],
						};
					},
					// biome-ignore lint/suspicious/noExplicitAny: minimal test double, not the real PipesClient shape
				}) as any,
		);

		const rows = await fetchSubscribedJobs();

		expect(rows).toEqual([
			{
				backend: "jenkins-auto",
				jobRef: "ocp-baremetal-ipi-deployment",
				runId: "40531",
				status: "running",
				url: "https://jenkins.example/40531",
				progressPercent: 42,
				overdue: false,
				startedAt: new Date(0),
				durationMs: undefined,
			},
		]);
	});

	it("maps ci.subscribed's own durationMs through once a run has settled", async () => {
		setJobsClientConnectorForTests(
			() =>
				({
					async call() {
						return {
							runs: [
								{
									backend: "jenkins-auto",
									jobRef: "ocp-baremetal-ipi-deployment",
									runId: "40531",
									status: "success",
									result: "SUCCESS",
									url: "",
									startedAt: new Date(0),
									fetchedAt: new Date(0),
									watched: true,
									durationMs: 123_456,
								},
							],
						};
					},
					// biome-ignore lint/suspicious/noExplicitAny: minimal test double
				}) as any,
		);

		const rows = await fetchSubscribedJobs();
		expect(rows[0]?.durationMs).toBe(123_456);
		expect(rows[0]?.startedAt).toEqual(new Date(0));
	});

	it("leaves progressPercent/overdue undefined when ci.subscribed's own run carries none (e.g. GitLab)", async () => {
		setJobsClientConnectorForTests(
			() =>
				({
					async call() {
						return {
							runs: [
								{
									backend: "gl",
									jobRef: "project",
									runId: "9",
									status: "running",
									result: "",
									url: "",
									startedAt: new Date(0),
									fetchedAt: new Date(0),
									watched: true,
								},
							],
						};
					},
					// biome-ignore lint/suspicious/noExplicitAny: minimal test double
				}) as any,
		);

		const rows = await fetchSubscribedJobs();
		expect(rows[0]?.progressPercent).toBeUndefined();
		expect(rows[0]?.overdue).toBeUndefined();
	});

	it("maps ci.subscribed's own projectName through when present", async () => {
		setJobsClientConnectorForTests(
			() =>
				({
					async call() {
						return {
							runs: [
								{
									backend: "jenkins-auto",
									jobRef: "ocp-baremetal-ipi-deployment",
									runId: "40531",
									status: "running",
									result: "",
									url: "",
									startedAt: new Date(0),
									fetchedAt: new Date(0),
									watched: true,
									projectRoot: "/home/x/pipes",
									projectName: "pipes",
								},
							],
						};
					},
					// biome-ignore lint/suspicious/noExplicitAny: minimal test double
				}) as any,
		);

		const rows = await fetchSubscribedJobs();
		expect(rows[0]?.projectName).toBe("pipes");
	});

	it("propagates a connector failure (e.g. daemon not running) as a rejection -- the overlay is responsible for catching it", async () => {
		setJobsClientConnectorForTests(() => {
			throw new Error("Pipes daemon is not running; run `pipes serve`.");
		});

		await expect(fetchSubscribedJobs()).rejects.toThrow(/daemon is not running/);
	});
});

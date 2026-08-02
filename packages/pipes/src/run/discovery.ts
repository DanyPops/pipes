export interface RepoInfo {
	name: string;
	fullName: string;
	private: boolean;
}

export interface WorkflowInfo {
	name: string;
	/** Valid as the workflow half of a "repo/workflow.yml" jobRef against an account-scoped backend. */
	fileName: string;
	state: string;
}

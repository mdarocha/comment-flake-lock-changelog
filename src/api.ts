import core from "@actions/core";
import github from "@actions/github";
import GetFileContentAtCommitQuery from "~/queries/GetFileContentAtCommit.graphql" with { type: "text" };
import type { GetFileContentAtCommitResponse } from "~/queries/GetFileContentAtCommit.graphql";
import GetPullRequestChangedFilesQuery from "~/queries/GetPullRequestChangedFiles.graphql" with { type: "text" };
import type { GetPullRequestChangedFilesResponse } from "~/queries/GetPullRequestChangedFiles.graphql";
import GetPullRequestRefsQuery from "~/queries/GetPullRequestRefs.graphql" with { type: "text" };
import type { GetPullRequestRefsResponse } from "~/queries/GetPullRequestRefs.graphql";

function getGithubClient(): ReturnType<typeof github.getOctokit> {
    const token = core.getInput("token");
    return github.getOctokit(token);
}

export async function getPullRequestChangedFiles(prNumber: number): Promise<string[]> {
    const client = getGithubClient();
    const { repo } = github.context;

    const result = await client.graphql<GetPullRequestChangedFilesResponse>(GetPullRequestChangedFilesQuery, {
        ...repo,
        prNumber,
    });

    const data = result.data.repository.pullRequest.files;
    if (data.totalCount > data.nodes.length) {
        core.warning("Not all files were loaded due to a large PR diff, some files may be missing from the changelog.");
    }

    return data.nodes.map((node) => node.path);
}

export async function getPullRequestRefs(prNumber: number): Promise<{ base: string; head: string }> {
    const client = getGithubClient();
    const { repo } = github.context;

    const result = await client.graphql<GetPullRequestRefsResponse>(GetPullRequestRefsQuery, {
        ...repo,
        prNumber,
    });

    return {
        base: result.data.repository.pullRequest.baseRefOid,
        head: result.data.repository.pullRequest.headRefOid,
    };
}

export async function getFileContentAtCommit(commit: string, path: string): Promise<string> {
    const client = getGithubClient();
    const { repo } = github.context;

    const normalizedPath = path.startsWith("/") ? path.slice(1) : path;

    const result = await client.graphql<GetFileContentAtCommitResponse>(GetFileContentAtCommitQuery, {
        ...repo,
        expression: `${commit}:${normalizedPath}`,
    });

    return result.data.repository.object.text;
}

// TODO tests
export async function compareCommits(
    owner: string,
    repo: string,
    base: string,
    head: string,
): Promise<Array<{ message: string; url: string }>> {
    const client = getGithubClient();
    const { data: compareData } = await client.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${base}...${head}`,
    });

    return compareData.commits.map((commit) => ({
        message: commit.commit.message.split("\n")[0],
        url: commit.html_url,
    }));
}

// TODO tests
// TODO optimize this to make less api calls
export async function getPullRequestForCommit(
    owner: string,
    repo: string,
    commit: string,
): Promise<{ id: string; url: string } | null> {
    const client = getGithubClient();
    const { data: associatedPRs } = await client.rest.repos.listPullRequestsAssociatedWithCommit({
        owner,
        repo,
        commit_sha: commit,
    });

    if (associatedPRs.length === 0) {
        return null;
    }

    return {
        id: associatedPRs[0].id,
        url: associatedPRs[0].html_url,
    };
}

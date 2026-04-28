import * as core from "@actions/core";
import * as github from "@actions/github";
import type { GetResponseDataTypeFromEndpointMethod } from "@octokit/types";
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

    const data = result.repository.pullRequest.files;
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
        base: result.repository.pullRequest.baseRefOid,
        head: result.repository.pullRequest.headRefOid,
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

    return result.repository.object.text;
}

// TODO tests
export async function compareCommits(
    owner: string,
    repo: string,
    base: string,
    head: string,
): Promise<Array<{ sha: string; message: string; url: string }>> {
    const client = getGithubClient();

    try {
        const { data: compareData } = await client.rest.repos.compareCommitsWithBasehead({
            owner,
            repo,
            basehead: `${base}...${head}`,
        });

        return compareData.commits.map((commit) => ({
            sha: commit.sha,
            message: commit.commit.message.split("\n")[0],
            url: commit.html_url,
        }));
    } catch (error) {
        if (error instanceof Error && error.message.includes("No common ancestor")) {
            core.warning(
                `No common ancestor between ${base} and ${head} in ${owner}/${repo}. ` +
                    "The repository history may have been rewritten. Skipping commit changelog for this input.",
            );
            return [];
        }
        throw error;
    }
}

const LEGACY_COMMENT_TAG_PATTERN = `<!-- thollander/actions-comment-pull-request "comment-flake-lock-changelog" -->`;
const COMMENT_TAG_PATTERN = `<!-- mdarocha/comment-flake-lock-changelog -->`;

// GitHub enforces a hard 65,536-character limit on issue/PR comment bodies.
const GITHUB_COMMENT_MAX_LENGTH = 65536;
const TRUNCATION_NOTICE =
    "\n\n> [!NOTE]\n> The changelog was truncated because it exceeded GitHub's maximum comment size of 65,536 characters.";

/**
 * Attaches the identity tag to `body` and truncates the result to GitHub's
 * comment-size limit.  When truncation is needed the body is cut to fit and
 * `TRUNCATION_NOTICE` is inserted so readers know the output is incomplete.
 */
function buildCommentBody(body: string): string {
    const tag = `\n${COMMENT_TAG_PATTERN}`;
    const full = `${body}${tag}`;
    if (full.length <= GITHUB_COMMENT_MAX_LENGTH) {
        return full;
    }
    // Reserve space for the tag and the truncation notice, then slice the body.
    const available = GITHUB_COMMENT_MAX_LENGTH - tag.length - TRUNCATION_NOTICE.length;
    return `${body.slice(0, available)}${TRUNCATION_NOTICE}${tag}`;
}

export async function upsertComment(prNumber: number, body: string): Promise<void> {
    const client = getGithubClient();
    const { repo } = github.context;

    const wouldExceed = `${body}\n${COMMENT_TAG_PATTERN}`.length > GITHUB_COMMENT_MAX_LENGTH;
    if (wouldExceed) {
        core.warning("Comment body exceeded GitHub's maximum comment size of 65,536 characters and was truncated.");
    }
    const taggedBody = buildCommentBody(body);

    function hasCommentTag(comment: { body?: string | null }): boolean {
        return (
            comment?.body?.includes(COMMENT_TAG_PATTERN) === true ||
            comment?.body?.includes(LEGACY_COMMENT_TAG_PATTERN) === true
        );
    }

    type ListCommentsResponseDataType = GetResponseDataTypeFromEndpointMethod<typeof client.rest.issues.listComments>;
    let existingComment: ListCommentsResponseDataType[0] | undefined;

    for await (const { data: comments } of client.paginate.iterator(client.rest.issues.listComments, {
        ...repo,
        issue_number: prNumber,
    })) {
        existingComment = comments.find(hasCommentTag);
        if (existingComment) break;
    }

    if (existingComment) {
        core.info(`Updating existing comment ${existingComment.id}`);
        await client.rest.issues.updateComment({
            ...repo,
            comment_id: existingComment.id,
            body: taggedBody,
        });
    } else {
        core.info("Creating new comment");
        await client.rest.issues.createComment({
            ...repo,
            issue_number: prNumber,
            body: taggedBody,
        });
    }
}

// TODO tests
// TODO optimize this to make less api calls
export async function getPullRequestForCommit(
    owner: string,
    repo: string,
    commit: string,
): Promise<{ id: number; url: string } | null> {
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

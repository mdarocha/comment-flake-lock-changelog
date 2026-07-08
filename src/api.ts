import * as cache from "@actions/cache";
import * as core from "@actions/core";
import * as github from "@actions/github";
import type { GetResponseDataTypeFromEndpointMethod } from "@octokit/types";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

export async function getFileContentAtCommit(commit: string, filePath: string): Promise<string> {
    const client = getGithubClient();
    const { repo } = github.context;

    const normalizedPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;

    const result = await client.graphql<GetFileContentAtCommitResponse>(GetFileContentAtCommitQuery, {
        ...repo,
        expression: `${commit}:${normalizedPath}`,
    });

    return result.repository.object.text;
}

const compareCommitsCache = new Map<string, Array<{ sha: string; message: string; url: string }>>();
const prForCommitCache = new Map<string, { id: number; url: string } | null>();

export function clearCaches(): void {
    compareCommitsCache.clear();
    prForCommitCache.clear();
}

export async function compareCommits(
    owner: string,
    repo: string,
    base: string,
    head: string,
): Promise<Array<{ sha: string; message: string; url: string }>> {
    const cacheKey = `${owner}/${repo}@${base}...${head}`;
    const cached = compareCommitsCache.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }

    const client = getGithubClient();

    try {
        const { data: compareData } = await client.rest.repos.compareCommitsWithBasehead({
            owner,
            repo,
            basehead: `${base}...${head}`,
        });

        const result = compareData.commits.map((commit) => ({
            sha: commit.sha,
            message: commit.commit.message.split("\n")[0],
            url: commit.html_url,
        }));
        compareCommitsCache.set(cacheKey, result);
        return result;
    } catch (error) {
        if (error instanceof Error && error.message.includes("No common ancestor")) {
            core.warning(
                `No common ancestor between ${base} and ${head} in ${owner}/${repo}. ` +
                    "The repository history may have been rewritten. Skipping commit changelog for this input.",
            );
            const empty: Array<{ sha: string; message: string; url: string }> = [];
            compareCommitsCache.set(cacheKey, empty);
            return empty;
        }
        throw error;
    }
}

const LEGACY_COMMENT_TAG_PATTERN = `<!-- thollander/actions-comment-pull-request "comment-flake-lock-changelog" -->`;
export const COMMENT_TAG_PATTERN = `<!-- mdarocha/comment-flake-lock-changelog -->`;

// GitHub enforces a hard 65,536-character limit on issue/PR comment bodies.
export const GITHUB_COMMENT_MAX_LENGTH = 65536;
const TRUNCATION_NOTICE =
    "\n\n> [!NOTE]\n> The changelog was truncated because it exceeded GitHub's maximum comment size of 65,536 characters.";

/**
 * Attaches the identity tag to `body` and truncates the result to GitHub's
 * comment-size limit.  When truncation is needed the body is cut at the last
 * complete line that fits, and `TRUNCATION_NOTICE` is appended so readers know
 * the output is incomplete.
 */
function buildCommentBody(body: string): string {
    const tag = `\n${COMMENT_TAG_PATTERN}`;
    const full = `${body}${tag}`;
    if (full.length <= GITHUB_COMMENT_MAX_LENGTH) {
        return full;
    }
    // Reserve space for the tag and the truncation notice, then cut at the
    // last newline within the available window to avoid breaking markdown.
    const available = GITHUB_COMMENT_MAX_LENGTH - tag.length - TRUNCATION_NOTICE.length;
    const cutIndex = body.lastIndexOf("\n", available);
    const safeBody = cutIndex > 0 ? body.slice(0, cutIndex) : body.slice(0, available);
    return `${safeBody}${TRUNCATION_NOTICE}${tag}`;
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

export async function getPullRequestForCommit(
    owner: string,
    repo: string,
    commit: string,
): Promise<{ id: number; url: string } | null> {
    const cacheKey = `${owner}/${repo}@${commit}`;
    if (prForCommitCache.has(cacheKey)) {
        return prForCommitCache.get(cacheKey)!;
    }

    const client = getGithubClient();
    const { data: associatedPRs } = await client.rest.repos.listPullRequestsAssociatedWithCommit({
        owner,
        repo,
        commit_sha: commit,
    });

    const result = associatedPRs.length === 0 ? null : { id: associatedPRs[0].id, url: associatedPRs[0].html_url };
    prForCommitCache.set(cacheKey, result);
    return result;
}

export interface PullRequestDetails {
    authorLogin: string;
    body: string;
}

export async function getPullRequestDetails(prNumber: number): Promise<PullRequestDetails> {
    const client = getGithubClient();
    const { repo } = github.context;

    const { data } = await client.rest.pulls.get({
        ...repo,
        pull_number: prNumber,
    });

    return {
        authorLogin: data.user.login,
        body: data.body ?? "",
    };
}

interface CacheFile {
    compareCommits: Record<string, Array<{ sha: string; message: string; url: string }>>;
    prForCommit: Record<string, { id: number; url: string } | null>;
}

function getCacheKeyAndPath(owner: string, repo: string): { key: string; filePath: string } {
    const key = `comment-flake-lock-changelog-v1-${owner}-${repo}`;
    const filePath = path.join(os.tmpdir(), `${key}.json`);
    return { key, filePath };
}

export async function restoreCacheForRepo(owner: string, repo: string): Promise<void> {
    const { key, filePath } = getCacheKeyAndPath(owner, repo);
    try {
        const hit = await cache.restoreCache([filePath], key);
        if (!hit) {
            return;
        }
        const raw = fs.readFileSync(filePath, "utf8");
        const cacheFile = JSON.parse(raw) as CacheFile;
        for (const [k, v] of Object.entries(cacheFile.compareCommits)) {
            compareCommitsCache.set(k, v);
        }
        for (const [k, v] of Object.entries(cacheFile.prForCommit)) {
            prForCommitCache.set(k, v);
        }
    } catch (err) {
        core.debug(`Cache restore unavailable or failed: ${String(err)}`);
    }
}

export async function saveCacheForRepo(owner: string, repo: string): Promise<void> {
    const { key, filePath } = getCacheKeyAndPath(owner, repo);
    try {
        const compareCommitsEntries: CacheFile["compareCommits"] = {};
        for (const [k, commits] of compareCommitsCache.entries()) {
            compareCommitsEntries[k] = commits;
        }
        const prForCommitEntries: CacheFile["prForCommit"] = {};
        for (const [k, v] of prForCommitCache.entries()) {
            prForCommitEntries[k] = v;
        }
        const cacheFile: CacheFile = {
            compareCommits: compareCommitsEntries,
            prForCommit: prForCommitEntries,
        };
        fs.writeFileSync(filePath, JSON.stringify(cacheFile), "utf8");
        await cache.saveCache([filePath], key);
    } catch (err) {
        core.debug(`Cache save unavailable or failed: ${String(err)}`);
    }
}

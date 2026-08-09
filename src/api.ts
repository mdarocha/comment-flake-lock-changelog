import * as cache from "@actions/cache";
import * as core from "@actions/core";
import * as github from "@actions/github";
import type { GetResponseDataTypeFromEndpointMethod } from "@octokit/types";
import * as crypto from "node:crypto";
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

    const paths: string[] = [];
    let after: string | null = null;
    let totalCount = 0;

    // The PR's file list is paginated by GitHub's GraphQL API (100 per page); walk every
    // page via pageInfo.hasNextPage/endCursor instead of only ever reading the first one.
    for (;;) {
        const result: GetPullRequestChangedFilesResponse = await client.graphql<GetPullRequestChangedFilesResponse>(
            GetPullRequestChangedFilesQuery,
            {
                ...repo,
                prNumber,
                after,
            },
        );

        const data = result.repository.pullRequest.files;
        totalCount = data.totalCount;
        paths.push(...data.nodes.map((node) => node.path));

        if (!data.pageInfo.hasNextPage) {
            break;
        }
        after = data.pageInfo.endCursor;
    }

    if (totalCount > paths.length) {
        core.warning("Not all files were loaded due to a large PR diff, some files may be missing from the changelog.");
    }

    return paths;
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

type BuildFilterResult = {
    relevant: Array<{ sha: string; message: string; url: string }>;
    irrelevant: Array<{ sha: string; message: string; url: string }>;
};
const buildFilterResultCache = new Map<string, BuildFilterResult>();

export function clearCaches(): void {
    compareCommitsCache.clear();
    prForCommitCache.clear();
    buildFilterResultCache.clear();
}

/**
 * Cache key for a build-filter bisection result. Bisecting a commit range is
 * expensive (a clone plus a build per bisect step), so a result is only worth
 * reusing while every input that can change its outcome is unchanged: the
 * exact commit range being bisected, the input name being overridden, the
 * build command itself, and `nixStateHash` (a hash of every `*.nix` file and
 * `flake.lock` in the consuming repo — see computeNixStateHash in
 * buildFilter.ts), since any of those can change what the build evaluates to
 * without the commit range itself moving.
 */
export function buildFilterCacheKey(
    nixStateHash: string,
    buildCommand: string,
    diff: { beforeRev: string; rev: string; name: string },
): string {
    const buildCommandHash = crypto.createHash("sha256").update(buildCommand).digest("hex");
    return `${nixStateHash}:${buildCommandHash}:${diff.name}@${diff.beforeRev}...${diff.rev}`;
}

export function getCachedBuildFilterResult(cacheKey: string): BuildFilterResult | undefined {
    return buildFilterResultCache.get(cacheKey);
}

export function setCachedBuildFilterResult(cacheKey: string, result: BuildFilterResult): void {
    buildFilterResultCache.set(cacheKey, result);
}

type RawCommit = { sha: string; commit: { message: string }; html_url: string };

/**
 * GitHub's compare API caps the `commits` array at 250 entries regardless of the
 * range's real size (`total_commits` reports the true count but the array itself
 * isn't paginated further). When that cap is hit, walk `head`'s history via the
 * (properly paginated) commits API instead, collecting everything down to `base`,
 * so ranges beyond the cap aren't silently dropped from the changelog or the
 * build-filter bisect.
 */
async function listCommitsBetween(
    client: ReturnType<typeof getGithubClient>,
    owner: string,
    repo: string,
    base: string,
    head: string,
    totalCommits: number,
): Promise<RawCommit[]> {
    const collected: RawCommit[] = [];
    // Safety margin in case history doesn't converge on `base` within a sane number
    // of commits (e.g. unexpected force-push); avoids paginating indefinitely.
    const hardLimit = totalCommits * 4 + 1000;

    for await (const { data: page } of client.paginate.iterator(client.rest.repos.listCommits, {
        owner,
        repo,
        sha: head,
        per_page: 100,
    })) {
        for (const commit of page as RawCommit[]) {
            if (commit.sha === base) {
                return collected.reverse();
            }
            collected.push(commit);
            if (collected.length >= hardLimit) {
                core.warning(
                    `${owner}/${repo}@${base}...${head}: gave up walking commit history after ${collected.length} ` +
                        `commits without finding ${base}; changelog may be incomplete.`,
                );
                return collected.reverse();
            }
        }
    }

    core.warning(
        `${owner}/${repo}@${base}...${head}: reached the end of ${head}'s history without finding ${base}; ` +
            "changelog may be incomplete.",
    );
    return collected.reverse();
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
        core.info(`compareCommits: ${cacheKey} — cache hit, ${cached.length} commit(s)`);
        return cached;
    }

    const client = getGithubClient();

    core.info(`compareCommits: ${cacheKey} — comparing`);

    try {
        const { data: compareData } = await client.rest.repos.compareCommitsWithBasehead({
            owner,
            repo,
            basehead: `${base}...${head}`,
        });

        let rawCommits: RawCommit[] = compareData.commits;
        const totalCommits = compareData.total_commits ?? rawCommits.length;
        core.info(
            `compareCommits: ${cacheKey} — compare API returned ${rawCommits.length} of ${totalCommits} commit(s)`,
        );
        if (totalCommits > rawCommits.length) {
            // Expected/routine (the compare API caps its commits array at 250 regardless
            // of range size), not a problem — informational only, so this is core.info
            // rather than core.warning.
            core.info(
                `${owner}/${repo}@${base}...${head}: compare API returned ${rawCommits.length} of ${totalCommits} ` +
                    "commits; fetching the remainder via the commits API.",
            );
            rawCommits = await listCommitsBetween(client, owner, repo, base, head, totalCommits);
            core.info(`compareCommits: ${cacheKey} — recovered ${rawCommits.length} commit(s) via pagination fallback`);
        }

        const result = rawCommits.map((commit) => ({
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
        // GitHub 404s a commit comparison when either endpoint is unreachable from
        // the API's perspective — most commonly an upstream flake input revision
        // that was garbage-collected or rewritten away after the lockfile pinned
        // it. That's routine for fast-moving inputs (nixpkgs-unstable, etc.), not
        // an error in this action or the PR under test, so degrade to a warning
        // and an empty changelog for this input rather than failing the whole run.
        if (typeof error === "object" && error !== null && "status" in error && error.status === 404) {
            core.warning(
                `compareCommits: ${owner}/${repo}@${base}...${head} — GitHub returned 404 comparing these ` +
                    "commits (one of them is likely unreachable upstream, e.g. garbage-collected or rewritten). " +
                    "Skipping commit changelog for this input.",
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
    buildFilterResults: Record<string, BuildFilterResult>;
}

// GitHub Actions caches are immutable per exact key within a scope (branch):
// once a key exists, every later attempt to save to that same key fails. A bare,
// unversioned prefix as the literal key (the previous approach here) meant the
// very first successful save on a branch permanently "froze" the cache — every
// later run on that branch restored that same first snapshot but silently failed
// to persist anything newer (the failure only ever surfaced via a hidden
// core.debug call), and every *different* branch (the common case: a fresh
// per-bump PR from update-flake-lock, this action's own documented example) never
// matched the exact key at all, so it never benefited from caching in the first
// place. Save under a key suffixed with the run/attempt (always unique, so the
// save always succeeds) and restore via a prefix match on the stable prefix (so a
// later run still finds the most recent save regardless of its exact suffix) —
// the same primary-key + restore-prefix split cache-nix-action itself uses.
function getCachePrefix(owner: string, repo: string): string {
    return `comment-flake-lock-changelog-v1-${owner}-${repo}`;
}

function getCacheFilePath(owner: string, repo: string): string {
    return path.join(os.tmpdir(), `${getCachePrefix(owner, repo)}.json`);
}

export async function restoreCacheForRepo(owner: string, repo: string): Promise<void> {
    const prefix = getCachePrefix(owner, repo);
    const filePath = getCacheFilePath(owner, repo);
    try {
        // primaryKey never exact-matches (actual saves are always suffixed), so this
        // always falls through to the restoreKeys prefix match against the most
        // recent save.
        const hit = await cache.restoreCache([filePath], prefix, [prefix]);
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
        for (const [k, v] of Object.entries(cacheFile.buildFilterResults ?? {})) {
            buildFilterResultCache.set(k, v);
        }
    } catch (err) {
        core.debug(`Cache restore unavailable or failed: ${String(err)}`);
    }
}

export async function saveCacheForRepo(owner: string, repo: string): Promise<void> {
    const prefix = getCachePrefix(owner, repo);
    const filePath = getCacheFilePath(owner, repo);
    try {
        const compareCommitsEntries: CacheFile["compareCommits"] = {};
        for (const [k, commits] of compareCommitsCache.entries()) {
            compareCommitsEntries[k] = commits;
        }
        const prForCommitEntries: CacheFile["prForCommit"] = {};
        for (const [k, v] of prForCommitCache.entries()) {
            prForCommitEntries[k] = v;
        }
        const buildFilterResultEntries: CacheFile["buildFilterResults"] = {};
        for (const [k, v] of buildFilterResultCache.entries()) {
            buildFilterResultEntries[k] = v;
        }
        const cacheFile: CacheFile = {
            compareCommits: compareCommitsEntries,
            prForCommit: prForCommitEntries,
            buildFilterResults: buildFilterResultEntries,
        };
        fs.writeFileSync(filePath, JSON.stringify(cacheFile), "utf8");
        const runId = process.env["GITHUB_RUN_ID"] ?? Date.now().toString();
        const runAttempt = process.env["GITHUB_RUN_ATTEMPT"] ?? "1";
        await cache.saveCache([filePath], `${prefix}-${runId}-${runAttempt}`);
    } catch (err) {
        core.debug(`Cache save unavailable or failed: ${String(err)}`);
    }
}

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    buildFilterCacheKey,
    clearCaches,
    compareCommits,
    getCachedBuildFilterResult,
    getFileContentAtCommit,
    getPullRequestChangedFiles,
    getPullRequestDetails,
    getPullRequestForCommit,
    getPullRequestRefs,
    restoreCacheForRepo,
    saveCacheForRepo,
    setCachedBuildFilterResult,
    upsertComment,
} from "~/api";
import GetFileContentAtCommitQuery from "~/queries/GetFileContentAtCommit.graphql" with { type: "text" };
import type { GetFileContentAtCommitResponse } from "~/queries/GetFileContentAtCommit.graphql";
import GetPullRequestChangedFilesQuery from "~/queries/GetPullRequestChangedFiles.graphql" with { type: "text" };
import type { GetPullRequestChangedFilesResponse } from "~/queries/GetPullRequestChangedFiles.graphql";
import GetPullRequestRefsQuery from "~/queries/GetPullRequestRefs.graphql" with { type: "text" };
import type { GetPullRequestRefsResponse } from "~/queries/GetPullRequestRefs.graphql";
import { mockModule } from "~/utils/mockModule";

const COMMENT_TAG = "<!-- mdarocha/comment-flake-lock-changelog -->";

let moduleMocks: Array<Awaited<ReturnType<typeof mockModule>>> = [];
let logMock: Mock<(log: string) => void>;
let infoMock: Mock<(log: string) => void>;
let createCommentMock: Mock<(params: unknown) => Promise<void>>;
let updateCommentMock: Mock<(params: unknown) => Promise<void>>;
let existingCommentsList: Array<{ id: number; body: string }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let compareCommitsMock: Mock<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let listPRsMock: Mock<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let listCommitsMock: Mock<any>;
// Pages the fake `client.paginate.iterator` yields when walking listCommits(sha: head).
let listCommitsPages: Array<Array<{ sha: string; commit: { message: string }; html_url: string }>>;

beforeEach(async () => {
    const testToken = `test_token_${Math.random()}`;

    createCommentMock = mock(async (_params: unknown) => {});
    updateCommentMock = mock(async (_params: unknown) => {});
    existingCommentsList = [];
    listCommitsPages = [];
    listCommitsMock = mock(async () => ({ data: [] }));

    const mockOctokit = {
        graphql: mock(async (query: string, variables: Record<string, unknown>) => {
            switch (query) {
                case GetPullRequestRefsQuery:
                    if (
                        variables["owner"] === "test_owner" &&
                        variables["repo"] === "test_repo" &&
                        variables["prNumber"] === 13
                    ) {
                        return {
                            repository: {
                                pullRequest: {
                                    baseRefOid: "8ec8ff054bb9ddd9a8acd0712afc5cf76bacfa48",
                                    headRefOid: "8dd1669bbe49111536c3e8d784857773a91a8c99",
                                },
                            },
                        } satisfies GetPullRequestRefsResponse;
                    }

                    throw new Error("Invalid arguments");
                case GetFileContentAtCommitQuery:
                    if (
                        variables["owner"] === "test_owner" &&
                        variables["repo"] === "test_repo" &&
                        variables["expression"] === "8dd1669bbe49111536c3e8d784857773a91a8c99:test.txt"
                    ) {
                        return {
                            repository: {
                                object: {
                                    text: ["TEST FILE", "line 1", "line 2"].join("\n"),
                                },
                            },
                        } satisfies GetFileContentAtCommitResponse;
                    }
                    throw new Error("Invalid arguments");
                case GetPullRequestChangedFilesQuery:
                    if (
                        variables["owner"] === "test_owner" &&
                        variables["repo"] === "test_repo" &&
                        variables["prNumber"] === 13
                    ) {
                        return {
                            repository: {
                                pullRequest: {
                                    files: {
                                        totalCount: 2,
                                        pageInfo: {
                                            endCursor: "end",
                                            hasNextPage: false,
                                        },
                                        nodes: [{ path: "text.txt" }, { path: "text2.txt" }],
                                    },
                                },
                            },
                        } satisfies GetPullRequestChangedFilesResponse;
                    }

                    if (
                        variables["owner"] === "test_owner" &&
                        variables["repo"] === "test_repo" &&
                        variables["prNumber"] === 16
                    ) {
                        return {
                            repository: {
                                pullRequest: {
                                    files: {
                                        totalCount: 4,
                                        pageInfo: {
                                            endCursor: "end",
                                            hasNextPage: false,
                                        },
                                        nodes: [{ path: "text.txt" }, { path: "text2.txt" }],
                                    },
                                },
                            },
                        } satisfies GetPullRequestChangedFilesResponse;
                    }
                    if (
                        variables["owner"] === "test_owner" &&
                        variables["repo"] === "test_repo" &&
                        variables["prNumber"] === 20
                    ) {
                        // Simulates a PR with more than one page of changed files: page 1 has
                        // no `after` cursor and reports hasNextPage; page 2 is fetched with
                        // the cursor from page 1 and is the last page.
                        if (variables["after"] == null) {
                            return {
                                repository: {
                                    pullRequest: {
                                        files: {
                                            totalCount: 3,
                                            pageInfo: {
                                                endCursor: "page1-end",
                                                hasNextPage: true,
                                            },
                                            nodes: [{ path: "a.txt" }, { path: "b.txt" }],
                                        },
                                    },
                                },
                            } satisfies GetPullRequestChangedFilesResponse;
                        }
                        if (variables["after"] === "page1-end") {
                            return {
                                repository: {
                                    pullRequest: {
                                        files: {
                                            totalCount: 3,
                                            pageInfo: {
                                                endCursor: "page2-end",
                                                hasNextPage: false,
                                            },
                                            nodes: [{ path: "c.txt" }],
                                        },
                                    },
                                },
                            } satisfies GetPullRequestChangedFilesResponse;
                        }
                        throw new Error("Invalid arguments");
                    }
                    throw new Error("Invalid arguments");
                default:
                    throw new Error("Invalid query");
            }
        }),
        paginate: {
            // Routes to whichever fake page set the test populated, based on which rest
            // method was passed in: existingCommentsList for issues.listComments (used by
            // upsertComment), listCommitsPages for repos.listCommits (used by compareCommits'
            // truncated-range fallback).
            iterator: mock((fn: unknown, _params: unknown) => {
                if (fn === listCommitsMock) {
                    return (async function* () {
                        for (const page of listCommitsPages) {
                            yield { data: page };
                        }
                    })();
                }
                return (async function* () {
                    yield { data: existingCommentsList };
                })();
            }),
        },
        rest: {
            issues: {
                listComments: {},
                createComment: createCommentMock,
                updateComment: updateCommentMock,
            },
            pulls: {
                get: mock(async ({ pull_number }: { owner: string; repo: string; pull_number: number }) => {
                    if (pull_number === 13) {
                        return {
                            data: {
                                user: { login: "dependabot[bot]" },
                                body: "PR body text with https://github.com/owner/dep/compare/abc..def",
                            },
                        };
                    }
                    throw new Error("Invalid pull_number");
                }),
            },
            repos: {
                compareCommitsWithBasehead: (compareCommitsMock = mock(
                    async ({ owner, repo, basehead }: { owner: string; repo: string; basehead: string }) => {
                        if (owner === "test_owner" && repo === "test_repo" && basehead === "abc123...def456") {
                            return {
                                data: {
                                    commits: [
                                        {
                                            sha: "aaa111",
                                            commit: { message: "feat: add feature\n\nBody" },
                                            html_url: "https://github.com/test_owner/test_repo/commit/aaa111",
                                        },
                                        {
                                            sha: "bbb222",
                                            commit: { message: "fix: resolve bug" },
                                            html_url: "https://github.com/test_owner/test_repo/commit/bbb222",
                                        },
                                    ],
                                },
                            };
                        }
                        if (owner === "test_owner" && repo === "test_repo" && basehead === "no_base...no_head") {
                            throw new Error("No common ancestor");
                        }
                        if (owner === "test_owner" && repo === "test_repo" && basehead === "gone_base...gone_head") {
                            const notFound = new Error("Not Found") as Error & { status: number };
                            notFound.status = 404;
                            throw notFound;
                        }
                        if (owner === "test_owner" && repo === "test_repo" && basehead === "base000...head999") {
                            // Simulates GitHub's compare API commit cap: total_commits reports
                            // the true range size, but the commits array itself is truncated.
                            return {
                                data: {
                                    total_commits: 5,
                                    commits: [
                                        {
                                            sha: "e1",
                                            commit: { message: "commit e1" },
                                            html_url: "https://github.com/test_owner/test_repo/commit/e1",
                                        },
                                        {
                                            sha: "e2",
                                            commit: { message: "commit e2" },
                                            html_url: "https://github.com/test_owner/test_repo/commit/e2",
                                        },
                                    ],
                                },
                            };
                        }
                        throw new Error("Invalid arguments");
                    },
                )),
                listCommits: listCommitsMock,
                listPullRequestsAssociatedWithCommit: (listPRsMock = mock(
                    async ({ owner, repo, commit_sha }: { owner: string; repo: string; commit_sha: string }) => {
                        if (owner === "test_owner" && repo === "test_repo" && commit_sha === "aaa111") {
                            return { data: [{ id: 42, html_url: "https://github.com/test_owner/test_repo/pull/42" }] };
                        }
                        if (owner === "test_owner" && repo === "test_repo" && commit_sha === "no_pr_commit") {
                            return { data: [] };
                        }
                        throw new Error("Invalid arguments");
                    },
                )),
            },
        },
    };

    logMock = mock(() => {});
    infoMock = mock(() => {});

    moduleMocks = [
        await mockModule("@actions/core", () => ({
            getInput: mock((input: string) => (input === "token" ? testToken : "")),
            warning: logMock,
            info: infoMock,
        })),
        await mockModule("@actions/github", () => ({
            getOctokit: mock((token: string) => (token === testToken ? mockOctokit : null)),
            context: {
                repo: {
                    owner: "test_owner",
                    repo: "test_repo",
                },
            },
        })),
    ];
});

afterEach(() => {
    for (const moduleMock of moduleMocks) {
        moduleMock.dispose();
    }
    clearCaches();
});

describe("getPullRequestChangedFiles", () => {
    test("should return proper values from the github api", async () => {
        const files = await getPullRequestChangedFiles(13);
        expect(logMock).not.toHaveBeenCalled();
        expect(files).toEqual(["text.txt", "text2.txt"]);
    });

    test("should throw an error if the github api returns an error", async () => {
        await expect(async () => {
            await getPullRequestChangedFiles(14);
        }).toThrow();
    });

    test("should log warning if not all files were loaded", async () => {
        const files = await getPullRequestChangedFiles(16);
        expect(logMock).toHaveBeenCalledWith(
            "Not all files were loaded due to a large PR diff, some files may be missing from the changelog.",
        );
        expect(files).toEqual(["text.txt", "text2.txt"]);
    });

    test("walks every page of a multi-page file list instead of stopping at the first", async () => {
        // Regression test for the changed-files list only ever reading GraphQL's first
        // page (100 files) despite pageInfo.hasNextPage being available to paginate on.
        const files = await getPullRequestChangedFiles(20);
        expect(files).toEqual(["a.txt", "b.txt", "c.txt"]);
        expect(logMock).not.toHaveBeenCalled();
    });
});

describe("getPullRequestRefs", () => {
    test("should return proper values from the github api", async () => {
        const { base, head } = await getPullRequestRefs(13);
        expect(base).toEqual("8ec8ff054bb9ddd9a8acd0712afc5cf76bacfa48");
        expect(head).toEqual("8dd1669bbe49111536c3e8d784857773a91a8c99");
    });

    test("should throw an error if the github api returns an error", async () => {
        await expect(async () => {
            await getPullRequestRefs(14);
        }).toThrow();
    });
});

describe("getFileContentAtCommit", () => {
    test("should return proper values from the github api", async () => {
        const content = await getFileContentAtCommit("8dd1669bbe49111536c3e8d784857773a91a8c99", "test.txt");

        expect(content).toEqual(["TEST FILE", "line 1", "line 2"].join("\n"));
    });

    test("should remove initial / from file path", async () => {
        const content = await getFileContentAtCommit("8dd1669bbe49111536c3e8d784857773a91a8c99", "/test.txt");
        expect(content).toEqual(["TEST FILE", "line 1", "line 2"].join("\n"));
    });

    test("should throw an error if the github api returns an error", async () => {
        await expect(async () => {
            await getFileContentAtCommit("8dd1669bbe49111536c3e8d784857773a91a8c99", "another-file.txt");
        }).toThrow();
    });
});

describe("upsertComment", () => {
    test("creates a new comment with body and tag appended", async () => {
        await upsertComment(1, "hello");

        expect(createCommentMock).toHaveBeenCalledTimes(1);
        const { body } = (createCommentMock.mock.calls[0] as [{ body: string }])[0];
        expect(body).toBe(`hello\n${COMMENT_TAG}`);
        expect(logMock).not.toHaveBeenCalled();
    });

    test("updates an existing comment matched by identity tag", async () => {
        existingCommentsList = [{ id: 42, body: `old body\n${COMMENT_TAG}` }];

        await upsertComment(1, "new body");

        expect(updateCommentMock).toHaveBeenCalledTimes(1);
        const { comment_id, body } = (updateCommentMock.mock.calls[0] as [{ comment_id: number; body: string }])[0];
        expect(comment_id).toBe(42);
        expect(body).toBe(`new body\n${COMMENT_TAG}`);
        expect(createCommentMock).not.toHaveBeenCalled();
    });

    test("truncates body and emits warning when over 65,536 characters", async () => {
        const body = "x".repeat(70_000);

        await upsertComment(1, body);

        const { body: posted } = (createCommentMock.mock.calls[0] as [{ body: string }])[0];
        expect(posted.length).toBeLessThanOrEqual(65536);
        expect(posted.endsWith(`\n${COMMENT_TAG}`)).toBe(true);
        expect(posted).toContain("[!NOTE]");
        expect(posted).toContain("truncated");
        expect(logMock).toHaveBeenCalledWith(
            "Comment body exceeded GitHub's maximum comment size of 65,536 characters and was truncated.",
        );
    });

    test("does not truncate or warn when body fits within the limit", async () => {
        const tag = `\n${COMMENT_TAG}`;
        const body = "x".repeat(65536 - tag.length);

        await upsertComment(1, body);

        const { body: posted } = (createCommentMock.mock.calls[0] as [{ body: string }])[0];
        expect(posted.length).toBe(65536);
        expect(posted).not.toContain("[!NOTE]");
        expect(logMock).not.toHaveBeenCalled();
    });
});

describe("getPullRequestDetails", () => {
    test("returns authorLogin and body", async () => {
        const details = await getPullRequestDetails(13);
        expect(details.authorLogin).toEqual("dependabot[bot]");
        expect(details.body).toEqual("PR body text with https://github.com/owner/dep/compare/abc..def");
    });

    test("throws on unknown PR number", async () => {
        await expect(async () => getPullRequestDetails(99)).toThrow();
    });
});

describe("compareCommits", () => {
    test("returns correct commits", async () => {
        const commits = await compareCommits("test_owner", "test_repo", "abc123", "def456");
        expect(commits).toEqual([
            {
                sha: "aaa111",
                message: "feat: add feature",
                url: "https://github.com/test_owner/test_repo/commit/aaa111",
            },
            {
                sha: "bbb222",
                message: "fix: resolve bug",
                url: "https://github.com/test_owner/test_repo/commit/bbb222",
            },
        ]);
    });

    test("calls API only once on cache hit", async () => {
        await compareCommits("test_owner", "test_repo", "abc123", "def456");
        await compareCommits("test_owner", "test_repo", "abc123", "def456");
        expect(compareCommitsMock).toHaveBeenCalledTimes(1);
    });

    test("returns empty array on no-common-ancestor", async () => {
        const commits = await compareCommits("test_owner", "test_repo", "no_base", "no_head");
        expect(commits).toEqual([]);
        expect(logMock).toHaveBeenCalled();
    });

    test("returns empty array on 404 (unreachable commit upstream)", async () => {
        const commits = await compareCommits("test_owner", "test_repo", "gone_base", "gone_head");
        expect(commits).toEqual([]);
        expect(logMock).toHaveBeenCalledWith(expect.stringContaining("GitHub returned 404 comparing these commits"));
    });

    test("falls back to paginated listCommits when the compare API truncates the range", async () => {
        // total_commits (5) exceeds the compare API's truncated commits array (2), so the
        // full range should be recovered by walking listCommits(sha: head) back to base.
        // Regression test for
        // https://github.com/mdarocha/comment-flake-lock-changelog/issues/316
        listCommitsPages = [
            [
                {
                    sha: "e5",
                    commit: { message: "commit e5" },
                    html_url: "https://github.com/test_owner/test_repo/commit/e5",
                },
                {
                    sha: "e4",
                    commit: { message: "commit e4" },
                    html_url: "https://github.com/test_owner/test_repo/commit/e4",
                },
                {
                    sha: "e3",
                    commit: { message: "commit e3" },
                    html_url: "https://github.com/test_owner/test_repo/commit/e3",
                },
            ],
            [
                {
                    sha: "e2",
                    commit: { message: "commit e2" },
                    html_url: "https://github.com/test_owner/test_repo/commit/e2",
                },
                {
                    sha: "e1",
                    commit: { message: "commit e1" },
                    html_url: "https://github.com/test_owner/test_repo/commit/e1",
                },
                {
                    sha: "base000",
                    commit: { message: "base commit" },
                    html_url: "https://github.com/test_owner/test_repo/commit/base000",
                },
            ],
        ];

        const commits = await compareCommits("test_owner", "test_repo", "base000", "head999");

        expect(commits.map((c) => c.sha)).toEqual(["e1", "e2", "e3", "e4", "e5"]);
        // This is expected/routine (the compare API caps its commits array), not a
        // problem, so it's logged via core.info rather than core.warning.
        expect(infoMock).toHaveBeenCalledWith(expect.stringContaining("compare API returned 2 of 5 commits"));
        expect(logMock).not.toHaveBeenCalled();
    });
});

describe("getPullRequestForCommit", () => {
    test("returns PR info for known commit", async () => {
        const pr = await getPullRequestForCommit("test_owner", "test_repo", "aaa111");
        expect(pr).toEqual({ id: 42, url: "https://github.com/test_owner/test_repo/pull/42" });
    });

    test("returns null when no PRs", async () => {
        const pr = await getPullRequestForCommit("test_owner", "test_repo", "no_pr_commit");
        expect(pr).toBeNull();
    });

    test("calls API only once on cache hit", async () => {
        await getPullRequestForCommit("test_owner", "test_repo", "aaa111");
        await getPullRequestForCommit("test_owner", "test_repo", "aaa111");
        expect(listPRsMock).toHaveBeenCalledTimes(1);
    });

    test("caches null result", async () => {
        await getPullRequestForCommit("test_owner", "test_repo", "no_pr_commit");
        await getPullRequestForCommit("test_owner", "test_repo", "no_pr_commit");
        expect(listPRsMock).toHaveBeenCalledTimes(1);
    });
});

describe("buildFilterCacheKey / getCachedBuildFilterResult / setCachedBuildFilterResult", () => {
    const diff = { beforeRev: "abc123", rev: "def456", name: "nixpkgs" };

    test("cache is empty before anything is stored", () => {
        const key = buildFilterCacheKey("hash1", "nix build", diff);
        expect(getCachedBuildFilterResult(key)).toBeUndefined();
    });

    test("returns what was stored under the same key", () => {
        const key = buildFilterCacheKey("hash1", "nix build", diff);
        const result = { relevant: [{ sha: "s1", message: "m", url: "u" }], irrelevant: [] };
        setCachedBuildFilterResult(key, result);
        expect(getCachedBuildFilterResult(key)).toEqual(result);
    });

    test("differs when the nix state hash differs", () => {
        expect(buildFilterCacheKey("hash1", "nix build", diff)).not.toBe(
            buildFilterCacheKey("hash2", "nix build", diff),
        );
    });

    test("differs when the build command differs", () => {
        expect(buildFilterCacheKey("hash1", "nix build", diff)).not.toBe(
            buildFilterCacheKey("hash1", "nix build --different-flag", diff),
        );
    });

    test("differs when the commit range differs", () => {
        const otherDiff = { ...diff, rev: "different-rev" };
        expect(buildFilterCacheKey("hash1", "nix build", diff)).not.toBe(
            buildFilterCacheKey("hash1", "nix build", otherDiff),
        );
    });

    test("differs when the input name differs", () => {
        const otherDiff = { ...diff, name: "home-manager" };
        expect(buildFilterCacheKey("hash1", "nix build", diff)).not.toBe(
            buildFilterCacheKey("hash1", "nix build", otherDiff),
        );
    });
});

describe("restoreCacheForRepo / saveCacheForRepo", () => {
    let restoreCacheMock: Mock<
        (paths: string[], primaryKey: string, restoreKeys?: string[]) => Promise<string | undefined>
    >;
    let saveCacheMock: Mock<(paths: string[], key: string) => Promise<number>>;
    let cacheModuleMock: Awaited<ReturnType<typeof mockModule>>;
    const filePath = path.join(os.tmpdir(), "comment-flake-lock-changelog-v1-test_owner-test_repo.json");
    const originalRunId = process.env["GITHUB_RUN_ID"];
    const originalRunAttempt = process.env["GITHUB_RUN_ATTEMPT"];

    beforeEach(async () => {
        restoreCacheMock = mock(async () => undefined);
        saveCacheMock = mock(async () => 0);
        cacheModuleMock = await mockModule("@actions/cache", () => ({
            restoreCache: restoreCacheMock,
            saveCache: saveCacheMock,
        }));
        fs.rmSync(filePath, { force: true });
    });

    afterEach(() => {
        cacheModuleMock.dispose();
        fs.rmSync(filePath, { force: true });
        if (originalRunId === undefined) {
            delete process.env["GITHUB_RUN_ID"];
        } else {
            process.env["GITHUB_RUN_ID"] = originalRunId;
        }
        if (originalRunAttempt === undefined) {
            delete process.env["GITHUB_RUN_ATTEMPT"];
        } else {
            process.env["GITHUB_RUN_ATTEMPT"] = originalRunAttempt;
        }
    });

    test("restoreCacheForRepo restores via a prefix fallback, not just an exact key", async () => {
        await restoreCacheForRepo("test_owner", "test_repo");

        expect(restoreCacheMock).toHaveBeenCalledTimes(1);
        const [, primaryKey, restoreKeys] = restoreCacheMock.mock.calls[0] as [string[], string, string[]];
        // Real saves are always suffixed (see below), so an exact match on the bare
        // prefix should never hit - restoreKeys is what actually finds a prior save.
        expect(restoreKeys).toEqual([primaryKey]);
    });

    test("saveCacheForRepo never reuses the same key across two runs, so neither save collides with the other", async () => {
        process.env["GITHUB_RUN_ID"] = "111";
        process.env["GITHUB_RUN_ATTEMPT"] = "1";
        await saveCacheForRepo("test_owner", "test_repo");
        const [, firstKey] = saveCacheMock.mock.calls[0] as [string[], string];

        process.env["GITHUB_RUN_ID"] = "222";
        process.env["GITHUB_RUN_ATTEMPT"] = "1";
        await saveCacheForRepo("test_owner", "test_repo");
        const [, secondKey] = saveCacheMock.mock.calls[1] as [string[], string];

        expect(saveCacheMock).toHaveBeenCalledTimes(2);
        expect(firstKey).not.toBe(secondKey);
        // Neither save key is the bare prefix either - that's the literal key the old,
        // broken implementation used, and it's exactly what made every save after the
        // first one on a branch fail silently (GitHub Actions caches are immutable per
        // exact key).
        expect(firstKey).not.toBe("comment-flake-lock-changelog-v1-test_owner-test_repo");
        expect(secondKey).not.toBe("comment-flake-lock-changelog-v1-test_owner-test_repo");
    });

    test("a cache hit on restore populates compareCommits' cache, so a matching call skips the API", async () => {
        fs.writeFileSync(
            filePath,
            JSON.stringify({
                compareCommits: {
                    "test_owner/test_repo@abc123...def456": [{ sha: "cached-sha", message: "cached", url: "u" }],
                },
                prForCommit: {},
            }),
            "utf8",
        );
        restoreCacheMock.mockImplementation(async () => "some-previous-run-key");

        await restoreCacheForRepo("test_owner", "test_repo");
        const commits = await compareCommits("test_owner", "test_repo", "abc123", "def456");

        expect(commits).toEqual([{ sha: "cached-sha", message: "cached", url: "u" }]);
        expect(compareCommitsMock).not.toHaveBeenCalled();
    });

    test("saveCacheForRepo persists build-filter results, and restoreCacheForRepo loads them back", async () => {
        const key = buildFilterCacheKey("some-nix-state-hash", "nix build", {
            beforeRev: "abc123",
            rev: "def456",
            name: "nixpkgs",
        });
        const result = { relevant: [{ sha: "s1", message: "m", url: "u" }], irrelevant: [] };
        setCachedBuildFilterResult(key, result);

        await saveCacheForRepo("test_owner", "test_repo");
        const written = JSON.parse(fs.readFileSync(filePath, "utf8"));
        expect(written.buildFilterResults[key]).toEqual(result);

        // Simulate a fresh process: nothing in memory, restore from the saved file.
        clearCaches();
        restoreCacheMock.mockImplementation(async () => "some-previous-run-key");
        await restoreCacheForRepo("test_owner", "test_repo");

        expect(getCachedBuildFilterResult(key)).toEqual(result);
    });

    test("restoreCacheForRepo tolerates a cache file saved before buildFilterResults existed", async () => {
        fs.writeFileSync(
            filePath,
            JSON.stringify({
                compareCommits: {},
                prForCommit: {},
            }),
            "utf8",
        );
        restoreCacheMock.mockImplementation(async () => "some-previous-run-key");

        await expect(restoreCacheForRepo("test_owner", "test_repo")).resolves.toBeUndefined();
    });
});

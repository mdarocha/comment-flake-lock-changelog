import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Mock } from "bun:test";
import {
    clearCaches,
    compareCommits,
    getFileContentAtCommit,
    getPullRequestChangedFiles,
    getPullRequestDetails,
    getPullRequestForCommit,
    getPullRequestRefs,
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
let createCommentMock: Mock<(params: unknown) => Promise<void>>;
let updateCommentMock: Mock<(params: unknown) => Promise<void>>;
let existingCommentsList: Array<{ id: number; body: string }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let compareCommitsMock: Mock<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let listPRsMock: Mock<any>;

beforeEach(async () => {
    const testToken = `test_token_${Math.random()}`;

    createCommentMock = mock(async (_params: unknown) => {});
    updateCommentMock = mock(async (_params: unknown) => {});
    existingCommentsList = [];

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
                    throw new Error("Invalid arguments");
                default:
                    throw new Error("Invalid query");
            }
        }),
        paginate: {
            // Yields existingCommentsList, which each test may populate before calling upsertComment.
            iterator: mock((_fn: unknown, _params: unknown) =>
                (async function* () {
                    yield { data: existingCommentsList };
                })(),
            ),
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
                        throw new Error("Invalid arguments");
                    },
                )),
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

    moduleMocks = [
        await mockModule("@actions/core", () => ({
            getInput: mock((input: string) => (input === "token" ? testToken : "")),
            warning: logMock,
            info: mock(() => {}),
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

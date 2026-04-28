import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Mock } from "bun:test";
import { getFileContentAtCommit, getPullRequestChangedFiles, getPullRequestRefs, upsertComment } from "~/api";
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

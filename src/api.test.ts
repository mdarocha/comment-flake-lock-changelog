import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Mock } from "bun:test";
import { getFileContentAtCommit, getPullRequestChangedFiles, getPullRequestRefs } from "~/api";
import GetFileContentAtCommitQuery from "~/queries/GetFileContentAtCommit.graphql" with { type: "text" };
import type { GetFileContentAtCommitResponse } from "~/queries/GetFileContentAtCommit.graphql";
import GetPullRequestChangedFilesQuery from "~/queries/GetPullRequestChangedFiles.graphql" with { type: "text" };
import type { GetPullRequestChangedFilesResponse } from "~/queries/GetPullRequestChangedFiles.graphql";
import GetPullRequestRefsQuery from "~/queries/GetPullRequestRefs.graphql" with { type: "text" };
import type { GetPullRequestRefsResponse } from "~/queries/GetPullRequestRefs.graphql";
import { mockModule } from "~/utils/mockModule";

let moduleMocks: Array<Awaited<ReturnType<typeof mockModule>>> = [];
let logMock: Mock<(log: string) => void>;

beforeEach(async () => {
    const testToken = `test_token_${Math.random()}`;

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
    };

    logMock = mock(() => {});

    moduleMocks = [
        await mockModule("@actions/core", () => ({
            getInput: mock((input: string) => (input === "token" ? testToken : "")),
            warning: logMock,
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

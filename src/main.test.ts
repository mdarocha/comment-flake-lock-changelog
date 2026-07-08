import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Mock } from "bun:test";
import { COMMENT_TAG_PATTERN, GITHUB_COMMENT_MAX_LENGTH } from "~/api";
import type { PullRequestDetails } from "~/api";
import { mockModule } from "~/utils/mockModule";

const BEFORE_LOCK = JSON.stringify({
    nodes: {
        root: { inputs: { nixpkgs: "nixpkgs" } },
        nixpkgs: { locked: { owner: "NixOS", repo: "nixpkgs", rev: "aaaa1111", type: "github" } },
    },
});
const AFTER_LOCK = JSON.stringify({
    nodes: {
        root: { inputs: { nixpkgs: "nixpkgs" } },
        nixpkgs: { locked: { owner: "NixOS", repo: "nixpkgs", rev: "bbbb2222", type: "github" } },
    },
});
const COMPARE_URL = "https://github.com/NixOS/nixpkgs/compare/aaaa1111..bbbb2222";

let moduleMocks: Array<Awaited<ReturnType<typeof mockModule>>> = [];
let upsertCommentMock: Mock<(prNumber: number, body: string) => Promise<void>>;
let getPullRequestDetailsMock: Mock<() => Promise<PullRequestDetails>>;
let getFileContentAtCommitMock: Mock<(commit: string, path: string) => Promise<string>>;
let warningMock: Mock<(message: string) => void>;
let buildFilterInput = "";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let compareCommitsMock: Mock<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let filterCommitsByBuildRelevanceMock: Mock<any>;

beforeEach(async () => {
    upsertCommentMock = mock(async () => {});
    getPullRequestDetailsMock = mock(async () => ({
        authorLogin: "dependabot[bot]",
        body: COMPARE_URL,
    }));
    getFileContentAtCommitMock = mock(async (commit: string, _path: string) =>
        commit === "basesha" ? BEFORE_LOCK : AFTER_LOCK,
    );
    compareCommitsMock = mock(async () => []);
    warningMock = mock(() => {});
    buildFilterInput = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    filterCommitsByBuildRelevanceMock = mock((commits: any[]) => ({ relevant: commits, irrelevant: [] }));

    moduleMocks = [
        await mockModule("@actions/core", () => ({
            getInput: mock((input: string) => {
                if (input === "pull-request-number") return "42";
                if (input === "build-filter") return buildFilterInput;
                return "";
            }),
            info: mock(() => {}),
            warning: warningMock,
        })),
        await mockModule("~/api", () => ({
            getPullRequestChangedFiles: mock(async () => ["flake.lock"]),
            getPullRequestRefs: mock(async () => ({ base: "basesha", head: "headsha" })),
            getFileContentAtCommit: getFileContentAtCommitMock,
            getPullRequestDetails: getPullRequestDetailsMock,
            compareCommits: compareCommitsMock,
            getPullRequestForCommit: mock(async () => null),
            upsertComment: upsertCommentMock,
            restoreCacheForRepo: mock(async () => {}),
            saveCacheForRepo: mock(async () => {}),
        })),
        await mockModule("~/buildFilter", () => ({
            filterCommitsByBuildRelevance: filterCommitsByBuildRelevanceMock,
        })),
    ];
});

afterEach(() => {
    for (const moduleMock of moduleMocks) {
        moduleMock.dispose();
    }
});

describe("run", () => {
    test("skips comment when dependabot PR already contains all compare URLs", async () => {
        // dynamic import required: mock must be installed before ~/main initialises
        // its ~/api bindings (Bun issue #7823, same pattern as index.test.ts).
        const { run } = await import("~/main");
        await run();
        expect(upsertCommentMock).not.toHaveBeenCalled();
    });

    test("posts comment when dependabot PR body is missing a compare URL", async () => {
        getPullRequestDetailsMock.mockImplementation(async () => ({
            authorLogin: "dependabot[bot]",
            body: "this description does not mention the compare url",
        }));
        // dynamic import required: same reason as above.
        const { run } = await import("~/main");
        await run();
        expect(upsertCommentMock).toHaveBeenCalledTimes(1);
    });

    test("places the no-common-ancestor note outside the accordion", async () => {
        getPullRequestDetailsMock.mockImplementation(async () => ({
            authorLogin: "someone",
            body: "",
        }));
        // dynamic import required: same reason as above.
        const { run } = await import("~/main");
        await run();

        const [, body] = upsertCommentMock.mock.calls[0];
        const noteIndex = body.indexOf("[!WARNING]") !== -1 ? body.indexOf("[!WARNING]") : body.indexOf("[!NOTE]");
        const closingIndex = body.indexOf("</details>");
        expect(noteIndex).toBeGreaterThan(-1);
        expect(closingIndex).toBeGreaterThan(-1);
        expect(noteIndex).toBeGreaterThan(closingIndex);
    });

    test("places the omitted-commits note outside the accordion and reserves room for the identity tag", async () => {
        getPullRequestDetailsMock.mockImplementation(async () => ({
            authorLogin: "someone",
            body: "",
        }));
        compareCommitsMock.mockImplementation(async () =>
            Array.from({ length: 2000 }, (_, i) => ({
                sha: `sha${i}`,
                message: `commit number ${i} padded so the list overflows the comment size limit`,
                url: `https://github.com/NixOS/nixpkgs/commit/sha${i}`,
            })),
        );
        // dynamic import required: same reason as above.
        const { run } = await import("~/main");
        await run();

        const [, body] = upsertCommentMock.mock.calls[0];
        const closingIndex = body.indexOf("</details>");
        const noteIndex = body.indexOf("more commit(s) were not shown");
        expect(noteIndex).toBeGreaterThan(-1);
        expect(closingIndex).toBeGreaterThan(-1);
        expect(noteIndex).toBeGreaterThan(closingIndex);
        // upsertComment is mocked here, so it never actually appends the identity tag —
        // add its real length back in to confirm the *tagged* body would still fit.
        const taggedLength = body.length + `\n${COMMENT_TAG_PATTERN}`.length;
        expect(taggedLength).toBeLessThanOrEqual(GITHUB_COMMENT_MAX_LENGTH);
    });

    test("guarantees every input's header and first commit even when other inputs also need truncation", async () => {
        getPullRequestDetailsMock.mockImplementation(async () => ({
            authorLogin: "someone",
            body: "",
        }));

        const BEFORE_TWO_INPUTS = JSON.stringify({
            nodes: {
                root: { inputs: { nixpkgs: "nixpkgs", utils: "utils" } },
                nixpkgs: { locked: { owner: "NixOS", repo: "nixpkgs", rev: "aaaa1111", type: "github" } },
                utils: { locked: { owner: "numtide", repo: "flake-utils", rev: "cccc3333", type: "github" } },
            },
        });
        const AFTER_TWO_INPUTS = JSON.stringify({
            nodes: {
                root: { inputs: { nixpkgs: "nixpkgs", utils: "utils" } },
                nixpkgs: { locked: { owner: "NixOS", repo: "nixpkgs", rev: "bbbb2222", type: "github" } },
                utils: { locked: { owner: "numtide", repo: "flake-utils", rev: "dddd4444", type: "github" } },
            },
        });
        getFileContentAtCommitMock.mockImplementation(async (commit: string, _path: string) =>
            commit === "basesha" ? BEFORE_TWO_INPUTS : AFTER_TWO_INPUTS,
        );

        // Both inputs individually would overflow the comment size limit on their own,
        // so satisfying both requires the reserve to be computed across all inputs up
        // front rather than input-by-input.
        compareCommitsMock.mockImplementation(async (owner: string, repo: string) =>
            Array.from({ length: 2000 }, (_, i) => ({
                sha: `${repo}-sha${i}`,
                message: `commit ${i} in ${repo}, padded so this line is long enough to overflow the size budget`,
                url: `https://github.com/${owner}/${repo}/commit/${repo}-sha${i}`,
            })),
        );

        // dynamic import required: same reason as above.
        const { run } = await import("~/main");
        await run();

        const [, body] = upsertCommentMock.mock.calls[0];
        expect(body).toContain("### [NixOS/nixpkgs]");
        expect(body).toContain("### [numtide/flake-utils]");
        expect(body).toContain("commit 0 in nixpkgs");
        expect(body).toContain("commit 0 in flake-utils");
        expect((body.match(/more commit\(s\) were not shown/g) ?? []).length).toBeGreaterThanOrEqual(1);
        expect(body.length).toBeLessThan(65536);
    });

    test("splits commits into a relevant list and a collapsed irrelevant section when build-filter is set", async () => {
        getPullRequestDetailsMock.mockImplementation(async () => ({
            authorLogin: "someone",
            body: "",
        }));
        buildFilterInput = 'nix build --override-input "$CFLC_INPUT_NAME" "path:$CFLC_INPUT_PATH"';
        const commits = [
            { sha: "sha0", message: "relevant commit", url: "https://github.com/NixOS/nixpkgs/commit/sha0" },
            { sha: "sha1", message: "irrelevant commit", url: "https://github.com/NixOS/nixpkgs/commit/sha1" },
        ];
        compareCommitsMock.mockImplementation(async () => commits);
        filterCommitsByBuildRelevanceMock.mockImplementation(() => ({
            relevant: [commits[0]],
            irrelevant: [commits[1]],
        }));

        const { run } = await import("~/main");
        await run();

        expect(filterCommitsByBuildRelevanceMock).toHaveBeenCalledTimes(1);
        const [passedCommits, passedDiff, passedCommand] = filterCommitsByBuildRelevanceMock.mock.calls[0] as [
            typeof commits,
            { owner: string; repo: string; name: string },
            string,
        ];
        expect(passedCommits).toEqual(commits);
        expect(passedDiff).toMatchObject({ owner: "NixOS", repo: "nixpkgs", name: "nixpkgs" });
        expect(passedCommand).toBe(buildFilterInput);

        const [, body] = upsertCommentMock.mock.calls[0];
        expect(body).toContain("relevant commit");
        expect(body).toContain("1 commit that did not affect the build output");
        // the irrelevant commit is only listed inside the collapsed section
        const summaryIndex = body.indexOf("that did not affect the build output");
        const irrelevantCommitIndex = body.indexOf("irrelevant commit");
        expect(irrelevantCommitIndex).toBeGreaterThan(summaryIndex);
    });

    test("falls back to showing every commit unfiltered when build-filter throws", async () => {
        getPullRequestDetailsMock.mockImplementation(async () => ({
            authorLogin: "someone",
            body: "",
        }));
        buildFilterInput = 'nix build --override-input "$CFLC_INPUT_NAME" "path:$CFLC_INPUT_PATH"';
        const commits = [
            { sha: "sha0", message: "first commit", url: "https://github.com/NixOS/nixpkgs/commit/sha0" },
            { sha: "sha1", message: "second commit", url: "https://github.com/NixOS/nixpkgs/commit/sha1" },
        ];
        compareCommitsMock.mockImplementation(async () => commits);
        filterCommitsByBuildRelevanceMock.mockImplementation(() => {
            throw new Error("git not found in PATH — cannot run build-filter");
        });

        const { run } = await import("~/main");
        await run();

        expect(warningMock).toHaveBeenCalledTimes(1);
        expect(warningMock.mock.calls[0][0]).toContain("build-filter failed");

        const [, body] = upsertCommentMock.mock.calls[0];
        expect(body).toContain("first commit");
        expect(body).toContain("second commit");
        expect(body).not.toContain("that did not affect the build output");
    });
});

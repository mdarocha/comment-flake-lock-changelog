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
let infoMock: Mock<(message: string) => void>;
let debugMock: Mock<(message: string) => void>;
let isDebugEnabled = false;
let buildFilterInput = "";
let buildFilterConcurrencyInput = "";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let compareCommitsMock: Mock<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let filterCommitsByBuildRelevanceMock: Mock<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getCachedBuildFilterResultMock: Mock<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let setCachedBuildFilterResultMock: Mock<any>;

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
    infoMock = mock(() => {});
    debugMock = mock(() => {});
    isDebugEnabled = false;
    buildFilterInput = "";
    buildFilterConcurrencyInput = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    filterCommitsByBuildRelevanceMock = mock((commits: any[]) => ({ relevant: commits, irrelevant: [] }));
    getCachedBuildFilterResultMock = mock(() => undefined);
    setCachedBuildFilterResultMock = mock(() => {});

    moduleMocks = [
        await mockModule("@actions/core", () => ({
            getInput: mock((input: string) => {
                if (input === "pull-request-number") return "42";
                if (input === "build-filter") return buildFilterInput;
                if (input === "build-filter-concurrency") return buildFilterConcurrencyInput;
                return "";
            }),
            info: infoMock,
            warning: warningMock,
            isDebug: mock(() => isDebugEnabled),
            debug: debugMock,
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
            buildFilterCacheKey: mock(
                (nixStateHash: string, buildCommand: string, diff: { beforeRev: string; rev: string; name: string }) =>
                    `${nixStateHash}:${buildCommand}:${diff.name}@${diff.beforeRev}...${diff.rev}`,
            ),
            getCachedBuildFilterResult: getCachedBuildFilterResultMock,
            setCachedBuildFilterResult: setCachedBuildFilterResultMock,
        })),
        await mockModule("~/buildFilter", () => ({
            filterCommitsByBuildRelevance: filterCommitsByBuildRelevanceMock,
            computeNixStateHash: mock(() => "fake-nix-state-hash"),
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

    test("still posts a comment for dependabot when build-filter is set, even if compare URLs are already present", async () => {
        // build-filter's relevant/irrelevant split is information dependabot's own PR
        // description never has, so it's worth posting even when the redundant-compare-URL
        // skip would otherwise apply.
        buildFilterInput = 'nix build --override-input "$CFLC_INPUT_NAME" "path:$CFLC_INPUT_PATH"';
        // dynamic import required: same reason as above.
        const { run } = await import("~/main");
        await run();
        expect(upsertCommentMock).toHaveBeenCalledTimes(1);
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

    test("never logs a per-commit PR-lookup line via core.info, even over a large irrelevant list", async () => {
        // Regression test: a wide flake.lock bump can classify thousands of commits as
        // irrelevant, and an unconditional core.info() per commit in the render loop is
        // enough synchronous stdout writes to crash the whole action with EPIPE — the
        // same failure mode buildFilter.ts's per-commit classification logging was fixed
        // for previously. This loop (main.ts's PR-lookup pass) had the same bug.
        getPullRequestDetailsMock.mockImplementation(async () => ({
            authorLogin: "someone",
            body: "",
        }));
        buildFilterInput = 'nix build --override-input "$CFLC_INPUT_NAME" "path:$CFLC_INPUT_PATH"';
        const relevantCommit = {
            sha: "sha0",
            message: "relevant commit",
            url: "https://github.com/NixOS/nixpkgs/commit/sha0",
        };
        const irrelevantCommits = Array.from({ length: 250 }, (_, i) => ({
            sha: `irr${i}`,
            message: `irrelevant commit ${i}`,
            url: `https://github.com/NixOS/nixpkgs/commit/irr${i}`,
        }));
        compareCommitsMock.mockImplementation(async () => [relevantCommit, ...irrelevantCommits]);
        filterCommitsByBuildRelevanceMock.mockImplementation(() => ({
            relevant: [relevantCommit],
            irrelevant: irrelevantCommits,
        }));

        const { run } = await import("~/main");
        await run();

        expect(infoMock.mock.calls.some((c) => String(c[0]).includes("Checking for PRs"))).toBe(false);
    });

    test("logs the per-commit PR-lookup line via core.debug when step debugging is on", async () => {
        isDebugEnabled = true;
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

        expect(
            debugMock.mock.calls.some((c) =>
                String(c[0]).includes(`Checking for PRs associated with commit ${commits[1].sha}`),
            ),
        ).toBe(true);
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

    test("skips filterCommitsByBuildRelevance entirely on a build-filter result cache hit", async () => {
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
        const cached = { relevant: [commits[0]], irrelevant: [commits[1]] };
        getCachedBuildFilterResultMock.mockImplementation(() => cached);

        const { run } = await import("~/main");
        await run();

        expect(filterCommitsByBuildRelevanceMock).not.toHaveBeenCalled();
        expect(setCachedBuildFilterResultMock).not.toHaveBeenCalled();

        const [, body] = upsertCommentMock.mock.calls[0];
        expect(body).toContain("relevant commit");
        expect(body).toContain("1 commit that did not affect the build output");
    });

    test("stores the build-filter result in the cache on a cache miss", async () => {
        getPullRequestDetailsMock.mockImplementation(async () => ({
            authorLogin: "someone",
            body: "",
        }));
        buildFilterInput = 'nix build --override-input "$CFLC_INPUT_NAME" "path:$CFLC_INPUT_PATH"';
        const commits = [{ sha: "sha0", message: "a commit", url: "https://github.com/NixOS/nixpkgs/commit/sha0" }];
        compareCommitsMock.mockImplementation(async () => commits);
        const filtered = { relevant: commits, irrelevant: [] };
        filterCommitsByBuildRelevanceMock.mockImplementation(() => filtered);

        const { run } = await import("~/main");
        await run();

        expect(filterCommitsByBuildRelevanceMock).toHaveBeenCalledTimes(1);
        expect(setCachedBuildFilterResultMock).toHaveBeenCalledTimes(1);
        const [cacheKey, storedResult] = setCachedBuildFilterResultMock.mock.calls[0] as [string, typeof filtered];
        expect(typeof cacheKey).toBe("string");
        expect(storedResult).toEqual(filtered);
    });

    test("passes build-filter-concurrency through to build-filter as options.concurrency", async () => {
        getPullRequestDetailsMock.mockImplementation(async () => ({
            authorLogin: "someone",
            body: "",
        }));
        buildFilterInput = 'nix build --override-input "$CFLC_INPUT_NAME" "path:$CFLC_INPUT_PATH"';
        buildFilterConcurrencyInput = "8";
        const commits = [{ sha: "sha0", message: "a commit", url: "https://github.com/NixOS/nixpkgs/commit/sha0" }];
        compareCommitsMock.mockImplementation(async () => commits);
        filterCommitsByBuildRelevanceMock.mockImplementation(() => ({ relevant: commits, irrelevant: [] }));

        const { run } = await import("~/main");
        await run();

        const [, , , passedOptions] = filterCommitsByBuildRelevanceMock.mock.calls[0] as [
            typeof commits,
            unknown,
            string,
            { concurrency?: number },
        ];
        expect(passedOptions).toEqual({ concurrency: 8 });
    });

    test("defaults build-filter-concurrency to 4 when the input is empty", async () => {
        getPullRequestDetailsMock.mockImplementation(async () => ({
            authorLogin: "someone",
            body: "",
        }));
        buildFilterInput = 'nix build --override-input "$CFLC_INPUT_NAME" "path:$CFLC_INPUT_PATH"';
        // buildFilterConcurrencyInput left at its beforeEach default: "".
        const commits = [{ sha: "sha0", message: "a commit", url: "https://github.com/NixOS/nixpkgs/commit/sha0" }];
        compareCommitsMock.mockImplementation(async () => commits);
        filterCommitsByBuildRelevanceMock.mockImplementation(() => ({ relevant: commits, irrelevant: [] }));

        const { run } = await import("~/main");
        await run();

        const [, , , passedOptions] = filterCommitsByBuildRelevanceMock.mock.calls[0] as [
            typeof commits,
            unknown,
            string,
            { concurrency?: number },
        ];
        expect(passedOptions).toEqual({ concurrency: 4 });
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

    test("resolves the flake input path through a follows-deduplicated lock node key", async () => {
        getPullRequestDetailsMock.mockImplementation(async () => ({
            authorLogin: "someone",
            body: "",
        }));
        buildFilterInput = 'nix build --override-input "$CFLC_INPUT_NAME" "path:$CFLC_INPUT_PATH"';

        // Mirrors a real project where another input (e.g. devenv) locks its own nixpkgs
        // copy: Nix dedupes the project's own (non-`follows`) nixpkgs input into a
        // suffixed node key ("nixpkgs_2") even though flake.nix only ever calls it
        // "nixpkgs" — that's the name build-filter's CFLC_INPUT_NAME needs to be.
        const dedupedBefore = JSON.stringify({
            root: "root",
            nodes: {
                root: { inputs: { nixpkgs: "nixpkgs_2", devenv: "devenv" } },
                devenv: { inputs: { nixpkgs: "nixpkgs" } },
                nixpkgs: { locked: { owner: "NixOS", repo: "nixpkgs", rev: "devenv-pin", type: "github" } },
                nixpkgs_2: { locked: { owner: "NixOS", repo: "nixpkgs", rev: "aaaa1111", type: "github" } },
            },
        });
        const dedupedAfter = JSON.stringify({
            root: "root",
            nodes: {
                root: { inputs: { nixpkgs: "nixpkgs_2", devenv: "devenv" } },
                devenv: { inputs: { nixpkgs: "nixpkgs" } },
                nixpkgs: { locked: { owner: "NixOS", repo: "nixpkgs", rev: "devenv-pin", type: "github" } },
                nixpkgs_2: { locked: { owner: "NixOS", repo: "nixpkgs", rev: "bbbb2222", type: "github" } },
            },
        });
        getFileContentAtCommitMock.mockImplementation(async (commit: string) =>
            commit === "basesha" ? dedupedBefore : dedupedAfter,
        );
        const commits = [{ sha: "sha0", message: "a commit", url: "https://github.com/NixOS/nixpkgs/commit/sha0" }];
        compareCommitsMock.mockImplementation(async () => commits);
        filterCommitsByBuildRelevanceMock.mockImplementation(() => ({ relevant: commits, irrelevant: [] }));

        const { run } = await import("~/main");
        await run();

        expect(filterCommitsByBuildRelevanceMock).toHaveBeenCalledTimes(1);
        const [, passedDiff] = filterCommitsByBuildRelevanceMock.mock.calls[0] as [
            typeof commits,
            { owner: string; repo: string; name: string },
            string,
        ];
        expect(passedDiff.name).toBe("nixpkgs");
        expect(warningMock).not.toHaveBeenCalled();
    });

    test("resolves a nested input path when the changed node is only reachable through another input", async () => {
        getPullRequestDetailsMock.mockImplementation(async () => ({
            authorLogin: "someone",
            body: "",
        }));
        buildFilterInput = 'nix build --override-input "$CFLC_INPUT_NAME" "path:$CFLC_INPUT_PATH"';

        const nestedBefore = JSON.stringify({
            root: "root",
            nodes: {
                root: { inputs: { "flake-parts": "flake-parts_2" } },
                "flake-parts_2": { inputs: { nixpkgs: "nixpkgs_4" } },
                nixpkgs_4: { locked: { owner: "NixOS", repo: "nixpkgs", rev: "aaaa1111", type: "github" } },
            },
        });
        const nestedAfter = JSON.stringify({
            root: "root",
            nodes: {
                root: { inputs: { "flake-parts": "flake-parts_2" } },
                "flake-parts_2": { inputs: { nixpkgs: "nixpkgs_4" } },
                nixpkgs_4: { locked: { owner: "NixOS", repo: "nixpkgs", rev: "bbbb2222", type: "github" } },
            },
        });
        getFileContentAtCommitMock.mockImplementation(async (commit: string) =>
            commit === "basesha" ? nestedBefore : nestedAfter,
        );
        const commits = [{ sha: "sha0", message: "a commit", url: "https://github.com/NixOS/nixpkgs/commit/sha0" }];
        compareCommitsMock.mockImplementation(async () => commits);
        filterCommitsByBuildRelevanceMock.mockImplementation(() => ({ relevant: commits, irrelevant: [] }));

        const { run } = await import("~/main");
        await run();

        const [, passedDiff] = filterCommitsByBuildRelevanceMock.mock.calls[0] as [
            typeof commits,
            { owner: string; repo: string; name: string },
            string,
        ];
        expect(passedDiff.name).toBe("flake-parts/nixpkgs");
    });

    test("falls back to the raw node key and warns when no input path resolves to it", async () => {
        getPullRequestDetailsMock.mockImplementation(async () => ({
            authorLogin: "someone",
            body: "",
        }));
        buildFilterInput = 'nix build --override-input "$CFLC_INPUT_NAME" "path:$CFLC_INPUT_PATH"';

        // A node not reachable from root at all shouldn't normally happen, but the
        // resolver must degrade to the old (broken but non-crashing) behavior instead
        // of throwing.
        const unreachableBefore = JSON.stringify({
            root: "root",
            nodes: {
                root: { inputs: {} },
                orphan: { locked: { owner: "NixOS", repo: "nixpkgs", rev: "aaaa1111", type: "github" } },
            },
        });
        const unreachableAfter = JSON.stringify({
            root: "root",
            nodes: {
                root: { inputs: {} },
                orphan: { locked: { owner: "NixOS", repo: "nixpkgs", rev: "bbbb2222", type: "github" } },
            },
        });
        getFileContentAtCommitMock.mockImplementation(async (commit: string) =>
            commit === "basesha" ? unreachableBefore : unreachableAfter,
        );
        const commits = [{ sha: "sha0", message: "a commit", url: "https://github.com/NixOS/nixpkgs/commit/sha0" }];
        compareCommitsMock.mockImplementation(async () => commits);
        filterCommitsByBuildRelevanceMock.mockImplementation(() => ({ relevant: commits, irrelevant: [] }));

        const { run } = await import("~/main");
        await run();

        const [, passedDiff] = filterCommitsByBuildRelevanceMock.mock.calls[0] as [
            typeof commits,
            { owner: string; repo: string; name: string },
            string,
        ];
        expect(passedDiff.name).toBe("orphan");
        expect(warningMock).toHaveBeenCalledTimes(1);
        expect(warningMock.mock.calls[0][0]).toContain(
            'Could not resolve a flake input path for flake.lock node "orphan"',
        );
    });

    test("carries dir/host through from the locked node when present, and omits them when absent", async () => {
        getPullRequestDetailsMock.mockImplementation(async () => ({
            authorLogin: "someone",
            body: "",
        }));
        buildFilterInput = 'nix eval --override-input "$CFLC_INPUT_NAME" "$CFLC_INPUT_URL" --raw ".#drvPath"';

        const withDirHostBefore = JSON.stringify({
            root: "root",
            nodes: {
                root: { inputs: { nixpkgs: "nixpkgs" } },
                nixpkgs: {
                    locked: {
                        owner: "NixOS",
                        repo: "nixpkgs",
                        rev: "aaaa1111",
                        type: "github",
                        dir: "sub/flake",
                        host: "github.example.com",
                    },
                },
            },
        });
        const withDirHostAfter = JSON.stringify({
            root: "root",
            nodes: {
                root: { inputs: { nixpkgs: "nixpkgs" } },
                nixpkgs: {
                    locked: {
                        owner: "NixOS",
                        repo: "nixpkgs",
                        rev: "bbbb2222",
                        type: "github",
                        dir: "sub/flake",
                        host: "github.example.com",
                    },
                },
            },
        });
        getFileContentAtCommitMock.mockImplementation(async (commit: string) =>
            commit === "basesha" ? withDirHostBefore : withDirHostAfter,
        );
        const commits = [{ sha: "sha0", message: "a commit", url: "https://github.com/NixOS/nixpkgs/commit/sha0" }];
        compareCommitsMock.mockImplementation(async () => commits);
        filterCommitsByBuildRelevanceMock.mockImplementation(() => ({ relevant: commits, irrelevant: [] }));

        const { run } = await import("~/main");
        await run();

        const [, passedDiff] = filterCommitsByBuildRelevanceMock.mock.calls[0] as [
            typeof commits,
            { dir?: string; host?: string },
            string,
        ];
        expect(passedDiff.dir).toBe("sub/flake");
        expect(passedDiff.host).toBe("github.example.com");
    });

    test("omits dir/host (undefined, not empty string) when the locked node doesn't have them", async () => {
        getPullRequestDetailsMock.mockImplementation(async () => ({
            authorLogin: "someone",
            body: "",
        }));
        buildFilterInput = 'nix eval --override-input "$CFLC_INPUT_NAME" "$CFLC_INPUT_URL" --raw ".#drvPath"';
        // Default fixtures (BEFORE_LOCK/AFTER_LOCK) never set dir/host.
        const commits = [{ sha: "sha0", message: "a commit", url: "https://github.com/NixOS/nixpkgs/commit/sha0" }];
        compareCommitsMock.mockImplementation(async () => commits);
        filterCommitsByBuildRelevanceMock.mockImplementation(() => ({ relevant: commits, irrelevant: [] }));

        const { run } = await import("~/main");
        await run();

        const [, passedDiff] = filterCommitsByBuildRelevanceMock.mock.calls[0] as [
            typeof commits,
            { dir?: string; host?: string },
            string,
        ];
        expect(passedDiff.dir).toBeUndefined();
        expect(passedDiff.host).toBeUndefined();
        expect("dir" in passedDiff).toBe(false);
        expect("host" in passedDiff).toBe(false);
    });
});

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockModule } from "~/utils/mockModule";

type SpawnCall = { cmd: string; args: string[]; env: NodeJS.ProcessEnv | undefined };

let spawnCalls: SpawnCall[] = [];
let moduleMock: Awaited<ReturnType<typeof mockModule>>;
// Maps a checked-out sha to the fingerprint the fake build command should "print" to stdout.
let outputsBySha: Record<string, string> = {};
let gcExitCode = 0;

beforeEach(async () => {
    spawnCalls = [];
    outputsBySha = {};
    gcExitCode = 0;

    moduleMock = await mockModule("node:child_process", () => ({
        spawnSync: mock((cmd: string, args: string[] = [], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
            spawnCalls.push({ cmd, args, env: opts?.env });

            if (cmd === "git" && args[0] === "--version") {
                return { status: 0, stdout: "git version 2.43.0", stderr: "" };
            }
            if (cmd === "git" && args[0] === "clone") {
                return { status: 0, stdout: "", stderr: "" };
            }
            if (cmd === "git" && args[0] === "checkout") {
                return { status: 0, stdout: "", stderr: "" };
            }
            if (cmd === "nix" && args[0] === "store" && args[1] === "gc") {
                return gcExitCode === 0
                    ? { status: 0, stdout: "", stderr: "" }
                    : { status: gcExitCode, stdout: "", stderr: "gc exploded" };
            }
            if (cmd === "sh") {
                const sha = opts?.env?.["CFLC_INPUT_REV"] ?? "";
                return { status: 0, stdout: outputsBySha[sha] ?? "", stderr: "" };
            }
            return { status: 1, stdout: "", stderr: "unexpected command" };
        }),
    }));
});

afterEach(() => {
    moduleMock.dispose();
});

describe("filterCommitsByBuildRelevance", () => {
    test("checks git availability via `git --version`, not the external `which` command", async () => {
        const { filterCommitsByBuildRelevance } = await import("~/buildFilter");

        outputsBySha = { before: "out-a", c1: "out-a" };

        filterCommitsByBuildRelevance(
            [{ sha: "c1", message: "commit 1", url: "https://example.com/c1" }],
            { owner: "acme", repo: "flake-utils", beforeRev: "before", rev: "c1", name: "flake-utils" },
            "echo ok",
        );

        expect(spawnCalls.some((c) => c.cmd === "which")).toBe(false);
        expect(spawnCalls.some((c) => c.cmd === "git" && c.args[0] === "--version")).toBe(true);
    });

    test("throws a descriptive error when git is unavailable, without needing `which`", async () => {
        const { filterCommitsByBuildRelevance } = await import("~/buildFilter");

        moduleMock = await mockModule("node:child_process", () => ({
            spawnSync: mock(() => ({ status: 1, stdout: "", stderr: "not found" })),
        }));

        expect(() =>
            filterCommitsByBuildRelevance(
                [{ sha: "c1", message: "commit 1", url: "https://example.com/c1" }],
                { owner: "acme", repo: "flake-utils", beforeRev: "before", rev: "c1", name: "flake-utils" },
                "echo ok",
            ),
        ).toThrow("git not found in PATH");
    });

    test("passes CFLC_INPUT_NAME so one build command can target the input being bisected", async () => {
        const { filterCommitsByBuildRelevance } = await import("~/buildFilter");

        outputsBySha = { before: "out-a", c1: "out-a", c2: "out-a" };

        filterCommitsByBuildRelevance(
            [
                { sha: "c1", message: "commit 1", url: "https://example.com/c1" },
                { sha: "c2", message: "commit 2", url: "https://example.com/c2" },
            ],
            { owner: "acme", repo: "flake-utils", beforeRev: "before", rev: "c2", name: "flake-utils" },
            'echo "$CFLC_INPUT_NAME"',
        );

        const buildCalls = spawnCalls.filter((c) => c.cmd === "sh");
        expect(buildCalls.length).toBeGreaterThan(0);
        for (const call of buildCalls) {
            expect(call.env?.["CFLC_INPUT_NAME"]).toBe("flake-utils");
        }
    });

    test("classifies commits as relevant only when they change the build fingerprint", async () => {
        const { filterCommitsByBuildRelevance } = await import("~/buildFilter");

        // before -> c1: output changes (relevant). c1 -> c2: output stays the same (irrelevant).
        outputsBySha = { before: "out-a", c1: "out-b", c2: "out-b" };

        const { relevant, irrelevant } = filterCommitsByBuildRelevance(
            [
                { sha: "c1", message: "commit 1", url: "https://example.com/c1" },
                { sha: "c2", message: "commit 2", url: "https://example.com/c2" },
            ],
            { owner: "NixOS", repo: "nixpkgs", beforeRev: "before", rev: "c2", name: "nixpkgs" },
            'echo "$CFLC_INPUT_REV"',
        );

        expect(relevant.map((c) => c.sha)).toEqual(["c1"]);
        expect(irrelevant.map((c) => c.sha)).toEqual(["c2"]);
    });

    test("bisects against diff.rev, not the last entry of a truncated commits array", async () => {
        const { filterCommitsByBuildRelevance } = await import("~/buildFilter");

        // Simulates compareCommits' 250-commit API cap: the `commits` array passed in
        // stops at "c2", but the real range extends to diff.rev ("head"), where a
        // relevant change actually lives beyond what's visible in `commits`. Regression
        // test for https://github.com/mdarocha/comment-flake-lock-changelog/issues/316.
        //
        // Attributing the change to a specific commit is only possible once the caller
        // (compareCommits) also paginates past the cap — covered separately in
        // api.test.ts — but even without that, the bisect's upper endpoint must reflect
        // the real head so the range is never wrongly reported as fully identical.
        outputsBySha = { before: "out-a", c1: "out-a", c2: "out-a", head: "out-b" };

        const { relevant } = filterCommitsByBuildRelevance(
            [
                { sha: "c1", message: "commit 1", url: "https://example.com/c1" },
                { sha: "c2", message: "commit 2", url: "https://example.com/c2" },
            ],
            { owner: "NixOS", repo: "nixpkgs", beforeRev: "before", rev: "head", name: "nixpkgs" },
            'echo "$CFLC_INPUT_REV"',
        );

        // Before the fix, the bisect never built "head" at all — its endpoint was
        // commits[commits.length - 1].sha ("c2"), whose output matches "before", so the
        // range would be silently misreported as unaffected. Even though this particular
        // list is too incomplete for any single commit to take the blame, the endpoint
        // itself must be checked against the true head rather than the truncated list.
        expect(relevant).toEqual([]);
        const buildShas = spawnCalls.filter((c) => c.cmd === "sh").map((c) => c.env?.["CFLC_INPUT_REV"]);
        expect(buildShas).toContain("head");
    });

    test("does not build an extra redundant commit when the last visible commit is already diff.rev", async () => {
        const { filterCommitsByBuildRelevance } = await import("~/buildFilter");

        outputsBySha = { before: "out-a", c1: "out-b" };

        filterCommitsByBuildRelevance(
            [{ sha: "c1", message: "commit 1", url: "https://example.com/c1" }],
            { owner: "acme", repo: "flake-utils", beforeRev: "before", rev: "c1", name: "flake-utils" },
            'echo "$CFLC_INPUT_REV"',
        );

        const buildShas = spawnCalls.filter((c) => c.cmd === "sh").map((c) => c.env?.["CFLC_INPUT_REV"]);
        expect(buildShas).toEqual(["before", "c1"]);
    });
});

describe("filterCommitsByBuildRelevance per-commit debug logging", () => {
    let coreMock: Awaited<ReturnType<typeof mockModule>>;
    let debugMock: ReturnType<typeof mock>;
    let debugEnabled = false;

    beforeEach(async () => {
        debugEnabled = false;
        debugMock = mock(() => {});
        coreMock = await mockModule("@actions/core", () => ({
            info: mock(() => {}),
            warning: mock(() => {}),
            isDebug: mock(() => debugEnabled),
            debug: debugMock,
        }));
    });

    afterEach(() => {
        coreMock.dispose();
    });

    // @actions/core's debug() (like info()) writes to stdout unconditionally — the
    // Actions runner UI is what hides "debug"-level lines when step debugging isn't
    // enabled, not the client. A per-commit line over a range with hundreds or
    // thousands of commits (a routine size for a nixpkgs bump) can therefore still
    // burst enough synchronous writes to crash the action with EPIPE even if it's
    // logged via debug() instead of info(). The fix has to skip the call entirely via
    // isDebug(), not just downgrade its level.
    test("skips the per-commit classification write entirely when step debugging is off", async () => {
        const { filterCommitsByBuildRelevance } = await import("~/buildFilter");
        outputsBySha = { before: "out-a", c1: "out-b" };

        filterCommitsByBuildRelevance(
            [{ sha: "c1", message: "commit 1", url: "https://example.com/c1" }],
            { owner: "acme", repo: "flake-utils", beforeRev: "before", rev: "c1", name: "flake-utils" },
            "echo ok",
        );

        expect(debugMock).not.toHaveBeenCalled();
    });

    test("still writes the per-commit classification when step debugging is on", async () => {
        debugEnabled = true;
        const { filterCommitsByBuildRelevance } = await import("~/buildFilter");
        outputsBySha = { before: "out-a", c1: "out-b" };

        filterCommitsByBuildRelevance(
            [{ sha: "c1", message: "commit 1", url: "https://example.com/c1" }],
            { owner: "acme", repo: "flake-utils", beforeRev: "before", rev: "c1", name: "flake-utils" },
            "echo ok",
        );

        expect(debugMock).toHaveBeenCalledTimes(1);
        expect(debugMock.mock.calls[0][0]).toContain("c1 classified as relevant");
    });
});

describe("filterCommitsByBuildRelevance gcBetweenBuilds", () => {
    test("does not run nix store gc when gcBetweenBuilds is unset", async () => {
        const { filterCommitsByBuildRelevance } = await import("~/buildFilter");
        outputsBySha = { before: "out-a", c1: "out-a" };

        filterCommitsByBuildRelevance(
            [{ sha: "c1", message: "commit 1", url: "https://example.com/c1" }],
            { owner: "acme", repo: "flake-utils", beforeRev: "before", rev: "c1", name: "flake-utils" },
            "echo ok",
        );

        expect(spawnCalls.some((c) => c.cmd === "nix" && c.args[0] === "store")).toBe(false);
    });

    test("runs nix store gc after every build when gcBetweenBuilds is true", async () => {
        const { filterCommitsByBuildRelevance } = await import("~/buildFilter");
        outputsBySha = { before: "out-a", c1: "out-b", c2: "out-b" };

        filterCommitsByBuildRelevance(
            [
                { sha: "c1", message: "commit 1", url: "https://example.com/c1" },
                { sha: "c2", message: "commit 2", url: "https://example.com/c2" },
            ],
            { owner: "acme", repo: "flake-utils", beforeRev: "before", rev: "c2", name: "flake-utils" },
            'echo "$CFLC_INPUT_REV"',
            { gcBetweenBuilds: true },
        );

        // gc should run exactly once per build, immediately after it, not just once at
        // the end: endpoints "before"/"c2" build first, then the bisect builds the
        // midpoint "c1" to check whether it's needed as a boundary.
        const commandOrder = spawnCalls
            .filter((c) => c.cmd === "sh" || (c.cmd === "nix" && c.args[0] === "store"))
            .map((c) => (c.cmd === "sh" ? `build:${c.env?.["CFLC_INPUT_REV"]}` : "gc"));
        expect(commandOrder).toEqual(["build:before", "gc", "build:c2", "gc", "build:c1", "gc"]);
    });

    test("warns but does not throw when nix store gc fails", async () => {
        const warnings: string[] = [];
        const coreMock = await mockModule("@actions/core", () => ({
            info: mock(() => {}),
            warning: mock((message: string) => {
                warnings.push(message);
            }),
            isDebug: mock(() => false),
            debug: mock(() => {}),
        }));
        gcExitCode = 1;

        try {
            const { filterCommitsByBuildRelevance } = await import("~/buildFilter");
            outputsBySha = { before: "out-a", c1: "out-a" };

            const { relevant, irrelevant } = filterCommitsByBuildRelevance(
                [{ sha: "c1", message: "commit 1", url: "https://example.com/c1" }],
                { owner: "acme", repo: "flake-utils", beforeRev: "before", rev: "c1", name: "flake-utils" },
                "echo ok",
                { gcBetweenBuilds: true },
            );

            expect(relevant).toEqual([]);
            expect(irrelevant).toHaveLength(1);
            expect(warnings.some((w) => w.includes("nix store gc"))).toBe(true);
        } finally {
            coreMock.dispose();
        }
    });
});

describe("filterCommitsByBuildRelevance skipCheckout", () => {
    test("checks out each commit by default", async () => {
        const { filterCommitsByBuildRelevance } = await import("~/buildFilter");
        outputsBySha = { before: "out-a", c1: "out-b" };

        filterCommitsByBuildRelevance(
            [{ sha: "c1", message: "commit 1", url: "https://example.com/c1" }],
            { owner: "acme", repo: "flake-utils", beforeRev: "before", rev: "c1", name: "flake-utils" },
            'echo "$CFLC_INPUT_REV"',
        );

        const checkoutShas = spawnCalls
            .filter((c) => c.cmd === "git" && c.args[0] === "checkout")
            .map((c) => c.args[1]);
        expect(checkoutShas).toEqual(["before", "c1"]);
    });

    test("skips git checkout entirely when skipCheckout is true, while still building every commit", async () => {
        const { filterCommitsByBuildRelevance } = await import("~/buildFilter");
        outputsBySha = { before: "out-a", c1: "out-b" };

        const { relevant, irrelevant } = filterCommitsByBuildRelevance(
            [{ sha: "c1", message: "commit 1", url: "https://example.com/c1" }],
            { owner: "acme", repo: "flake-utils", beforeRev: "before", rev: "c1", name: "flake-utils" },
            'echo "$CFLC_INPUT_REV"',
            { skipCheckout: true },
        );

        expect(spawnCalls.some((c) => c.cmd === "git" && c.args[0] === "checkout")).toBe(false);
        // The build command itself still runs once per commit, with CFLC_INPUT_REV set
        // correctly — skipCheckout only means the *content* has to come from the build
        // command's own fetcher (e.g. git+file://...?rev=$CFLC_INPUT_REV), not that the
        // commit stops being tested.
        const buildShas = spawnCalls.filter((c) => c.cmd === "sh").map((c) => c.env?.["CFLC_INPUT_REV"]);
        expect(buildShas).toEqual(["before", "c1"]);
        expect(relevant).toHaveLength(1);
        expect(irrelevant).toEqual([]);
    });
});

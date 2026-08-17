import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mockModule } from "~/utils/mockModule";

type SpawnCall = { cmd: string; args: string[]; env: NodeJS.ProcessEnv | undefined };
type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };

// Extracts the sha from a `github:owner/repo/<sha>[?...]` CFLC_INPUT value — the
// only env var a build receives now, so it's the only way to tell which build a
// spawn call belongs to.
function shaFromCflcInput(cflcInput: string | undefined): string {
    return cflcInput?.match(/^github:[^/]+\/[^/]+\/([^?]+)/)?.[1] ?? "";
}

let spawnCalls: SpawnCall[] = [];
let moduleMock: Awaited<ReturnType<typeof mockModule>>;
// Maps a build's sha to the fingerprint the fake build command should "print" to stdout.
let outputsBySha: Record<string, string> = {};
let gcExitCode = 0;
// Manually-controlled build completions, keyed by sha. A build whose sha has an
// entry here only "finishes" (emits close) once the test calls the resolver
// deferBuild() returned — used to prove real overlap/bounded concurrency rather than
// relying on timing.
let deferredBuilds: Record<string, Promise<void>> = {};

function deferBuild(sha: string): () => void {
    const { promise, resolve } = Promise.withResolvers<void>();
    deferredBuilds[sha] = promise;
    return resolve;
}

// Fakes just enough of node:child_process's async ChildProcess surface for
// buildFilter.ts's spawnCmd: stdout/stderr as separate emitters, plus close/error on
// the child itself. Resolves on the next microtask (or once `wait` settles) rather
// than synchronously, matching real spawn()'s always-asynchronous event delivery.
function fakeChild(stdout: string, stderr: string, exitCode: number, wait?: Promise<void>): FakeChild {
    const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
    });
    void (async () => {
        await (wait ?? Promise.resolve());
        if (stdout) child.stdout.emit("data", Buffer.from(stdout));
        if (stderr) child.stderr.emit("data", Buffer.from(stderr));
        child.emit("close", exitCode);
    })();
    return child;
}

// Polls until `predicate` is true, for asserting on in-flight concurrent state that
// depends on how many microtask hops the mocked spawn chain needs — a fixed number of
// awaits is fragile, so this just waits for the real observable outcome instead.
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("waitFor: timed out waiting for condition");
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 1);
        await promise;
    }
}

beforeEach(async () => {
    spawnCalls = [];
    outputsBySha = {};
    gcExitCode = 0;
    deferredBuilds = {};

    moduleMock = await mockModule("node:child_process", () => ({
        spawn: mock((cmd: string, args: string[] = [], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
            spawnCalls.push({ cmd, args, env: opts?.env });

            if (cmd === "nix" && args[0] === "store" && args[1] === "gc") {
                return gcExitCode === 0 ? fakeChild("", "", 0) : fakeChild("", "gc exploded", gcExitCode);
            }
            if (cmd === "sh") {
                const sha = shaFromCflcInput(opts?.env?.["CFLC_INPUT"]);
                return fakeChild(outputsBySha[sha] ?? "", "", 0, deferredBuilds[sha]);
            }
            return fakeChild("", "unexpected command", 1);
        }),
    }));
});

afterEach(() => {
    moduleMock.dispose();
});

describe("filterCommitsByBuildRelevance", () => {
    test("classifies commits as relevant only when they change the build fingerprint", async () => {
        const { filterCommitsByBuildRelevance } = await import("~/buildFilter");

        // before -> c1: output changes (relevant). c1 -> c2: output stays the same (irrelevant).
        outputsBySha = { before: "out-a", c1: "out-b", c2: "out-b" };

        const { relevant, irrelevant } = await filterCommitsByBuildRelevance(
            [
                { sha: "c1", message: "commit 1", url: "https://example.com/c1" },
                { sha: "c2", message: "commit 2", url: "https://example.com/c2" },
            ],
            { owner: "NixOS", repo: "nixpkgs", beforeRev: "before", rev: "c2" },
            'echo "$CFLC_INPUT"',
        );

        expect(relevant.map((c) => c.sha)).toEqual(["c1"]);
        expect(irrelevant.map((c) => c.sha)).toEqual(["c2"]);
    });

    // Regression test: same scenario as the classification test above, but pinned to
    // concurrency: 1 (also the default when omitted) — the exact behavior the codebase
    // had before concurrent builds existed. Same classification, same number of builds
    // (endpoints "before"/"c2" plus the bisect midpoint "c1"), just reached through the
    // async code path instead of spawnSync.
    test("concurrency 1 (or omitted) matches the pre-concurrency sequential build count and classification", async () => {
        const { filterCommitsByBuildRelevance } = await import("~/buildFilter");
        outputsBySha = { before: "out-a", c1: "out-b", c2: "out-b" };

        const { relevant, irrelevant } = await filterCommitsByBuildRelevance(
            [
                { sha: "c1", message: "commit 1", url: "https://example.com/c1" },
                { sha: "c2", message: "commit 2", url: "https://example.com/c2" },
            ],
            { owner: "NixOS", repo: "nixpkgs", beforeRev: "before", rev: "c2" },
            'echo "$CFLC_INPUT"',
            { concurrency: 1 },
        );

        expect(relevant.map((c) => c.sha)).toEqual(["c1"]);
        expect(irrelevant.map((c) => c.sha)).toEqual(["c2"]);
        expect(spawnCalls.filter((c) => c.cmd === "sh")).toHaveLength(3);
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

        const { relevant } = await filterCommitsByBuildRelevance(
            [
                { sha: "c1", message: "commit 1", url: "https://example.com/c1" },
                { sha: "c2", message: "commit 2", url: "https://example.com/c2" },
            ],
            { owner: "NixOS", repo: "nixpkgs", beforeRev: "before", rev: "head" },
            'echo "$CFLC_INPUT"',
        );

        // Before the fix, the bisect never built "head" at all — its endpoint was
        // commits[commits.length - 1].sha ("c2"), whose output matches "before", so the
        // range would be silently misreported as unaffected. Even though this particular
        // list is too incomplete for any single commit to take the blame, the endpoint
        // itself must be checked against the true head rather than the truncated list.
        expect(relevant).toEqual([]);
        const buildShas = spawnCalls.filter((c) => c.cmd === "sh").map((c) => shaFromCflcInput(c.env?.["CFLC_INPUT"]));
        expect(buildShas).toContain("head");
    });

    test("does not build an extra redundant commit when the last visible commit is already diff.rev", async () => {
        const { filterCommitsByBuildRelevance } = await import("~/buildFilter");

        outputsBySha = { before: "out-a", c1: "out-b" };

        await filterCommitsByBuildRelevance(
            [{ sha: "c1", message: "commit 1", url: "https://example.com/c1" }],
            { owner: "acme", repo: "flake-utils", beforeRev: "before", rev: "c1" },
            'echo "$CFLC_INPUT"',
        );

        const buildShas = spawnCalls.filter((c) => c.cmd === "sh").map((c) => shaFromCflcInput(c.env?.["CFLC_INPUT"]));
        expect(buildShas.sort()).toEqual(["before", "c1"]);
    });
});

describe("filterCommitsByBuildRelevance CFLC_INPUT", () => {
    test("sets CFLC_INPUT to a github: flake ref for every build", async () => {
        const { filterCommitsByBuildRelevance } = await import("~/buildFilter");
        outputsBySha = { before: "out-a", c1: "out-a" };

        await filterCommitsByBuildRelevance(
            [{ sha: "c1", message: "commit 1", url: "https://example.com/c1" }],
            { owner: "acme", repo: "flake-utils", beforeRev: "before", rev: "c1" },
            'echo "$CFLC_INPUT"',
        );

        const buildCalls = spawnCalls.filter((c) => c.cmd === "sh");
        expect(buildCalls.length).toBeGreaterThan(0);
        expect(buildCalls.find((c) => shaFromCflcInput(c.env?.["CFLC_INPUT"]) === "before")?.env?.["CFLC_INPUT"]).toBe(
            "github:acme/flake-utils/before",
        );
        expect(buildCalls.find((c) => shaFromCflcInput(c.env?.["CFLC_INPUT"]) === "c1")?.env?.["CFLC_INPUT"]).toBe(
            "github:acme/flake-utils/c1",
        );
    });

    test("includes ?host= and &dir= when the diff's locked node has them", async () => {
        const { filterCommitsByBuildRelevance } = await import("~/buildFilter");
        outputsBySha = { before: "out-a", c1: "out-a" };

        await filterCommitsByBuildRelevance(
            [{ sha: "c1", message: "commit 1", url: "https://example.com/c1" }],
            {
                owner: "acme",
                repo: "flake-utils",
                beforeRev: "before",
                rev: "c1",
                host: "github.example.com",
                dir: "sub dir",
            },
            'echo "$CFLC_INPUT"',
        );

        const buildCall = spawnCalls.find((c) => c.cmd === "sh" && shaFromCflcInput(c.env?.["CFLC_INPUT"]) === "c1");
        expect(buildCall?.env?.["CFLC_INPUT"]).toBe("github:acme/flake-utils/c1?host=github.example.com&dir=sub%20dir");
    });
});

describe("filterCommitsByBuildRelevance concurrency", () => {
    test("two independent builds actually overlap in-flight, not just interleaved", async () => {
        const { filterCommitsByBuildRelevance } = await import("~/buildFilter");
        const resolveBefore = deferBuild("before");
        const resolveC1 = deferBuild("c1");
        outputsBySha = { before: "out-a", c1: "out-b" };

        // Single commit whose sha is also diff.rev: allShas is exactly [before, c1],
        // so both are the endpoint builds, which always run via Promise.all.
        const resultPromise = filterCommitsByBuildRelevance(
            [{ sha: "c1", message: "commit 1", url: "https://example.com/c1" }],
            { owner: "acme", repo: "flake-utils", beforeRev: "before", rev: "c1" },
            'echo "$CFLC_INPUT"',
            { concurrency: 2 },
        );

        // Neither build can finish (both are held open by deferBuild), so both
        // spawning proves they were genuinely in flight together, not one after the
        // other.
        await waitFor(() => spawnCalls.filter((c) => c.cmd === "sh").length === 2);
        const buildShas = spawnCalls
            .filter((c) => c.cmd === "sh")
            .map((c) => shaFromCflcInput(c.env?.["CFLC_INPUT"]))
            .sort();
        expect(buildShas).toEqual(["before", "c1"]);

        resolveBefore();
        resolveC1();
        const { relevant } = await resultPromise;
        expect(relevant.map((c) => c.sha)).toEqual(["c1"]);
    });

    test("never spawns more builds than the configured concurrency limit", async () => {
        const { filterCommitsByBuildRelevance } = await import("~/buildFilter");

        // 9 commits (indices 1-9 below "before" at index 0), rev pinned to the last
        // one so allShas is exactly these 10 entries, no extra append. Distinct
        // outputs at before/c4/c2/c9 force bisect() down this exact path:
        //   root [0,9] -> mid c4 -> Left [0,4] -> mid c2 -> {[0,2] -> mid c1, [2,4] -> mid c3}
        //                        -> Right [4,9] -> mid c6
        // c6, c1, and c3 are all held open by deferBuild, so none of them can resolve
        // on their own and race ahead of the assertion below. By the time c2 resolves
        // and requests c1 and c3, c6 is still holding the other of the 2 available
        // slots — so only one of {c1, c3} can actually spawn, and it stays that way
        // (a stable state, not a transient one) until c6 is released.
        const commits = Array.from({ length: 9 }, (_, i) => ({
            sha: `c${i + 1}`,
            message: `commit ${i + 1}`,
            url: `https://example.com/c${i + 1}`,
        }));
        outputsBySha = { before: "v0", c4: "v4", c2: "v2", c9: "v9" };
        const resolveC6 = deferBuild("c6");
        const resolveC1 = deferBuild("c1");
        const resolveC3 = deferBuild("c3");

        const resultPromise = filterCommitsByBuildRelevance(
            commits,
            { owner: "acme", repo: "flake-utils", beforeRev: "before", rev: "c9" },
            'echo "$CFLC_INPUT"',
            { concurrency: 2 },
        );

        await waitFor(() => {
            const revs = spawnCalls.filter((c) => c.cmd === "sh").map((c) => shaFromCflcInput(c.env?.["CFLC_INPUT"]));
            return revs.includes("c6") && (revs.includes("c1") || revs.includes("c3"));
        });

        const spawnedBeforeRelease = new Set(
            spawnCalls.filter((c) => c.cmd === "sh").map((c) => shaFromCflcInput(c.env?.["CFLC_INPUT"])),
        );
        expect(spawnedBeforeRelease.has("c6")).toBe(true);
        // Exactly one of c1/c3 spawned — the other is still queued behind the
        // semaphore, proving the concurrency: 2 limit was actually enforced rather
        // than every ready build starting immediately. This holds because c1/c3 are
        // both deferred too, so this isn't just a race we happened to observe mid-flight.
        expect(spawnedBeforeRelease.has("c1") !== spawnedBeforeRelease.has("c3")).toBe(true);

        // Releasing c6 frees a slot, letting the previously-queued one of {c1, c3} spawn.
        resolveC6();
        await waitFor(() => {
            const revs = spawnCalls.filter((c) => c.cmd === "sh").map((c) => shaFromCflcInput(c.env?.["CFLC_INPUT"]));
            return revs.includes("c1") && revs.includes("c3");
        });

        resolveC1();
        resolveC3();
        await resultPromise;
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

        await filterCommitsByBuildRelevance(
            [{ sha: "c1", message: "commit 1", url: "https://example.com/c1" }],
            { owner: "acme", repo: "flake-utils", beforeRev: "before", rev: "c1" },
            "echo ok",
        );

        expect(debugMock).not.toHaveBeenCalled();
    });

    test("still writes the per-commit classification when step debugging is on", async () => {
        debugEnabled = true;
        const { filterCommitsByBuildRelevance } = await import("~/buildFilter");
        outputsBySha = { before: "out-a", c1: "out-b" };

        await filterCommitsByBuildRelevance(
            [{ sha: "c1", message: "commit 1", url: "https://example.com/c1" }],
            { owner: "acme", repo: "flake-utils", beforeRev: "before", rev: "c1" },
            "echo ok",
        );

        expect(debugMock).toHaveBeenCalledTimes(1);
        expect(debugMock.mock.calls[0][0]).toContain("c1 classified as relevant");
    });
});

describe("filterCommitsByBuildRelevance GC always runs", () => {
    test("runs nix store gc after every build, with no option to disable it", async () => {
        const { filterCommitsByBuildRelevance } = await import("~/buildFilter");
        outputsBySha = { before: "out-a", c1: "out-b", c2: "out-b" };

        // No third `options` argument at all — there is no field left to opt in or
        // out with; gc must still run for every build.
        await filterCommitsByBuildRelevance(
            [
                { sha: "c1", message: "commit 1", url: "https://example.com/c1" },
                { sha: "c2", message: "commit 2", url: "https://example.com/c2" },
            ],
            { owner: "acme", repo: "flake-utils", beforeRev: "before", rev: "c2" },
            'echo "$CFLC_INPUT"',
        );

        const gcCalls = spawnCalls.filter((c) => c.cmd === "nix" && c.args[0] === "store" && c.args[1] === "gc");
        const buildCalls = spawnCalls.filter((c) => c.cmd === "sh");
        // Endpoints "before"/"c2" plus the bisect midpoint "c1" — one gc per build.
        expect(buildCalls).toHaveLength(3);
        expect(gcCalls).toHaveLength(3);
    });

    test("runs nix store gc after every build regardless of what the build command reads", async () => {
        const { filterCommitsByBuildRelevance } = await import("~/buildFilter");
        outputsBySha = { before: "out-a", c1: "out-a" };

        await filterCommitsByBuildRelevance(
            [{ sha: "c1", message: "commit 1", url: "https://example.com/c1" }],
            { owner: "acme", repo: "flake-utils", beforeRev: "before", rev: "c1" },
            'echo "$CFLC_INPUT"',
        );

        const gcCalls = spawnCalls.filter((c) => c.cmd === "nix" && c.args[0] === "store" && c.args[1] === "gc");
        expect(gcCalls.length).toBeGreaterThan(0);
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

            const { relevant, irrelevant } = await filterCommitsByBuildRelevance(
                [{ sha: "c1", message: "commit 1", url: "https://example.com/c1" }],
                { owner: "acme", repo: "flake-utils", beforeRev: "before", rev: "c1" },
                "echo ok",
            );

            expect(relevant).toEqual([]);
            expect(irrelevant).toHaveLength(1);
            expect(warnings.some((w) => w.includes("nix store gc"))).toBe(true);
        } finally {
            coreMock.dispose();
        }
    });
});

describe("computeNixStateHash", () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cflc-nix-state-"));
        const { resetNixStateHashCache } = await import("~/buildFilter");
        resetNixStateHashCache();
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("is stable across calls against the same tree", async () => {
        fs.writeFileSync(path.join(tmpDir, "flake.nix"), "{ }");
        fs.writeFileSync(path.join(tmpDir, "flake.lock"), "{}");

        const { computeNixStateHash } = await import("~/buildFilter");
        const first = computeNixStateHash(tmpDir);
        const second = computeNixStateHash(tmpDir);

        expect(first).toBe(second);
    });

    test("changes when a .nix file's content changes", async () => {
        fs.writeFileSync(path.join(tmpDir, "flake.nix"), "{ }");
        fs.writeFileSync(path.join(tmpDir, "flake.lock"), "{}");

        const { computeNixStateHash, resetNixStateHashCache } = await import("~/buildFilter");
        const before = computeNixStateHash(tmpDir);

        resetNixStateHashCache();
        fs.writeFileSync(path.join(tmpDir, "flake.nix"), "{ changed = true; }");
        const after = computeNixStateHash(tmpDir);

        expect(after).not.toBe(before);
    });

    test("changes when flake.lock content changes", async () => {
        fs.writeFileSync(path.join(tmpDir, "flake.nix"), "{ }");
        fs.writeFileSync(path.join(tmpDir, "flake.lock"), '{"nodes":{}}');

        const { computeNixStateHash, resetNixStateHashCache } = await import("~/buildFilter");
        const before = computeNixStateHash(tmpDir);

        resetNixStateHashCache();
        fs.writeFileSync(path.join(tmpDir, "flake.lock"), '{"nodes":{"a":1}}');
        const after = computeNixStateHash(tmpDir);

        expect(after).not.toBe(before);
    });

    test("ignores files that are neither *.nix nor flake.lock", async () => {
        fs.writeFileSync(path.join(tmpDir, "flake.nix"), "{ }");
        fs.writeFileSync(path.join(tmpDir, "flake.lock"), "{}");
        fs.writeFileSync(path.join(tmpDir, "README.md"), "some docs");

        const { computeNixStateHash, resetNixStateHashCache } = await import("~/buildFilter");
        const before = computeNixStateHash(tmpDir);

        resetNixStateHashCache();
        fs.writeFileSync(path.join(tmpDir, "README.md"), "different docs");
        const after = computeNixStateHash(tmpDir);

        expect(after).toBe(before);
    });

    test("skips ignored directories such as .git and node_modules", async () => {
        fs.writeFileSync(path.join(tmpDir, "flake.nix"), "{ }");
        fs.mkdirSync(path.join(tmpDir, ".git"));
        fs.writeFileSync(path.join(tmpDir, ".git", "config.nix"), "should be ignored");
        fs.mkdirSync(path.join(tmpDir, "node_modules"));
        fs.writeFileSync(path.join(tmpDir, "node_modules", "pkg.nix"), "should be ignored");

        const { computeNixStateHash, resetNixStateHashCache } = await import("~/buildFilter");
        const withIgnored = computeNixStateHash(tmpDir);

        resetNixStateHashCache();
        fs.rmSync(path.join(tmpDir, ".git"), { recursive: true, force: true });
        fs.rmSync(path.join(tmpDir, "node_modules"), { recursive: true, force: true });
        const withoutIgnored = computeNixStateHash(tmpDir);

        expect(withIgnored).toBe(withoutIgnored);
    });

    test("finds .nix files in nested subdirectories", async () => {
        fs.mkdirSync(path.join(tmpDir, "modules"));
        fs.writeFileSync(path.join(tmpDir, "modules", "nested.nix"), "{ }");

        const { computeNixStateHash, resetNixStateHashCache } = await import("~/buildFilter");
        const before = computeNixStateHash(tmpDir);

        resetNixStateHashCache();
        fs.writeFileSync(path.join(tmpDir, "modules", "nested.nix"), "{ changed = true; }");
        const after = computeNixStateHash(tmpDir);

        expect(after).not.toBe(before);
    });

    test("memoizes: a second call does not re-read the filesystem", async () => {
        fs.writeFileSync(path.join(tmpDir, "flake.nix"), "{ }");

        const { computeNixStateHash } = await import("~/buildFilter");
        const first = computeNixStateHash(tmpDir);

        // Mutate the tree without resetting the memoized hash — the second call
        // should still return the stale, memoized value rather than re-scanning.
        fs.writeFileSync(path.join(tmpDir, "flake.nix"), "{ changed = true; }");
        const second = computeNixStateHash(tmpDir);

        expect(second).toBe(first);
    });
});

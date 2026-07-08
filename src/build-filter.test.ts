import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockModule } from "~/utils/mockModule";

type SpawnCall = { cmd: string; args: string[]; env: NodeJS.ProcessEnv | undefined };

let spawnCalls: SpawnCall[] = [];
let moduleMock: Awaited<ReturnType<typeof mockModule>>;
// Maps a checked-out sha to the fingerprint the fake build command should "print" to stdout.
let outputsBySha: Record<string, string> = {};

beforeEach(async () => {
    spawnCalls = [];
    outputsBySha = {};

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
});

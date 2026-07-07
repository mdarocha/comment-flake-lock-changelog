import * as fs from "fs";
import { spawnSync } from "node:child_process";
import * as os from "os";
import * as path from "path";

type Commit = { sha: string; message: string; url: string };

interface Diff {
    owner: string;
    repo: string;
    beforeRev: string;
    rev: string;
}

function spawnCmd(cmd: string[], opts?: { cwd?: string }): { stdout: string; stderr: string; exitCode: number } {
    const result = spawnSync(cmd[0], cmd.slice(1), {
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
        encoding: "utf8",
    });
    return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.status ?? 1,
    };
}

function checkToolAvailable(tool: string): boolean {
    const result = spawnCmd(["which", tool]);
    return result.exitCode === 0;
}

function buildAtPath(repoPath: string, buildCommand: string, inputName: string): string {
    const fullCommand = `${buildCommand} --override-input ${inputName} path:${repoPath} --no-link --print-out-paths`;
    const result = spawnCmd(["sh", "-c", fullCommand]);
    if (result.exitCode !== 0) {
        throw new Error(`Build failed: ${result.stderr}`);
    }
    return result.stdout.trim();
}

/**
 * Filter commits by whether they affect the build output of the flake under test.
 *
 * For each commit in the changelog, the upstream repo is checked out at that commit
 * and the build command is run with `--override-input <inputName> path:<checkout>`.
 * A commit is "relevant" if its build output differs from the previous commit's output.
 *
 * Requires `git` and `nix` in PATH; throws a descriptive error if either is missing.
 *
 * NOTE: This performs one nix build per commit. For large changelogs this can be slow,
 * but subsequent builds benefit from nix store deduplication/caching.
 */
export async function filterCommitsByBuildRelevance(
    commits: Commit[],
    diff: Diff,
    buildCommand: string,
    inputName: string,
): Promise<{ relevant: Commit[]; irrelevant: Commit[] }> {
    if (!checkToolAvailable("git")) {
        throw new Error("git not found in PATH — cannot run build-filter");
    }
    if (!checkToolAvailable("nix")) {
        throw new Error("nix not found in PATH — cannot run build-filter");
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cflc-"));
    try {
        const repoPath = path.join(tmpDir, "repo");
        const repoUrl = `https://github.com/${diff.owner}/${diff.repo}`;

        // Blobless clone: fetch tree metadata only; blobs are fetched on demand during checkout.
        const cloneResult = spawnCmd(["git", "clone", "--filter=blob:none", "--no-checkout", repoUrl, repoPath]);
        if (cloneResult.exitCode !== 0) {
            throw new Error(`Failed to clone ${repoUrl}: ${cloneResult.stderr}`);
        }

        // Build at beforeRev, then at each commit in order.
        // outputs[0]   = beforeRev
        // outputs[i+1] = commits[i]
        const allShas = [diff.beforeRev, ...commits.map((c) => c.sha)];
        const outputs: string[] = [];

        for (const sha of allShas) {
            const checkoutResult = spawnCmd(["git", "checkout", sha], { cwd: repoPath });
            if (checkoutResult.exitCode !== 0) {
                throw new Error(`git checkout ${sha} failed: ${checkoutResult.stderr}`);
            }
            const output = buildAtPath(repoPath, buildCommand, inputName);
            outputs.push(output);
        }

        const relevant: Commit[] = [];
        const irrelevant: Commit[] = [];

        for (let i = 0; i < commits.length; i++) {
            // outputs has length commits.length + 1, so i and i+1 are always valid indices.
            if (outputs[i + 1] !== outputs[i]) {
                relevant.push(commits[i] as Commit);
            } else {
                irrelevant.push(commits[i] as Commit);
            }
        }

        return { relevant, irrelevant };
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

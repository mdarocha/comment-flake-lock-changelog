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

function spawnCmd(
    cmd: string[],
    opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
): { stdout: string; stderr: string; exitCode: number } {
    const result = spawnSync(cmd[0], cmd.slice(1), {
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts?.env !== undefined ? { env: opts.env } : {}),
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

/**
 * Bisect the commit range to find all boundary points where the build output changes.
 * O(k log N) builds where k = number of change points.
 */
function bisect(
    lo: number,
    hi: number,
    outLo: string,
    outHi: string,
    allShas: string[],
    outputs: Map<number, string>,
    buildFn: (sha: string) => string,
): void {
    if (outLo === outHi) {
        // Same output across range: all commits are irrelevant, fill without building
        for (let i = lo + 1; i <= hi; i++) outputs.set(i, outLo);
        return;
    }
    if (hi - lo === 1) {
        // Adjacent commits with different outputs: boundary already known
        outputs.set(hi, outHi);
        return;
    }
    const mid = Math.floor((lo + hi) / 2);
    const outMid = buildFn(allShas[mid]);
    outputs.set(mid, outMid);
    bisect(lo, mid, outLo, outMid, allShas, outputs, buildFn);
    bisect(mid, hi, outMid, outHi, allShas, outputs, buildFn);
}

/**
 * Filter commits by whether they affect the build output.
 *
 * The upstream repo is cloned and checked out at various commits. For each build,
 * the user-provided build command is run as-is in process.cwd() (the Actions workspace)
 * with CFLC_INPUT_PATH set to the upstream checkout and CFLC_INPUT_REV set to the SHA.
 * The command's stdout is used as the build fingerprint.
 *
 * Uses a bisect algorithm to minimize the number of builds: O(k log N) where
 * k = number of output change points, instead of O(N) for a linear scan.
 *
 * Requires `git` in PATH; throws a descriptive error if missing.
 */
export function filterCommitsByBuildRelevance(
    commits: Commit[],
    diff: Diff,
    buildCommand: string,
): { relevant: Commit[]; irrelevant: Commit[] } {
    if (!checkToolAvailable("git")) {
        throw new Error("git not found in PATH \u2014 cannot run build-filter");
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

        // allShas[0] = beforeRev, allShas[1..N] = commits[0..N-1].sha
        const allShas = [diff.beforeRev, ...commits.map((c) => c.sha)];

        const cmdParts = ["sh", "-c", buildCommand];

        const buildFn = (sha: string): string => {
            const checkoutResult = spawnCmd(["git", "checkout", sha], { cwd: repoPath });
            if (checkoutResult.exitCode !== 0) {
                throw new Error(`git checkout ${sha} failed: ${checkoutResult.stderr}`);
            }
            const result = spawnCmd(cmdParts, {
                cwd: process.cwd(),
                env: { ...process.env, CFLC_INPUT_PATH: repoPath, CFLC_INPUT_REV: sha },
            });
            if (result.exitCode !== 0) {
                throw new Error(`Build command failed at ${sha}: ${result.stderr}`);
            }
            return result.stdout.trim();
        };

        // Build at endpoints
        const outFirst = buildFn(allShas[0]);
        const outLast = buildFn(allShas[allShas.length - 1]);

        const outputs = new Map<number, string>();
        outputs.set(0, outFirst);
        outputs.set(allShas.length - 1, outLast);

        // Bisect to find all change boundaries
        bisect(0, allShas.length - 1, outFirst, outLast, allShas, outputs, buildFn);

        // Classify commits: commit[i] is relevant if outputs[i+1] !== outputs[i]
        const relevant: Commit[] = [];
        const irrelevant: Commit[] = [];

        for (let i = 0; i < commits.length; i++) {
            if (outputs.get(i + 1) !== outputs.get(i)) {
                relevant.push(commits[i]);
            } else {
                irrelevant.push(commits[i]);
            }
        }

        return { relevant, irrelevant };
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

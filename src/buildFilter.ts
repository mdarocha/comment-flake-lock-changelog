import * as core from "@actions/core";
import * as fs from "fs";
import { spawnSync } from "node:child_process";
import * as os from "os";
import * as path from "path";

const LOG_FINGERPRINT_MAX_LENGTH = 200;

function truncateForLog(value: string, maxLength = LOG_FINGERPRINT_MAX_LENGTH): string {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, maxLength)}... (${value.length} chars total)`;
}

type Commit = { sha: string; message: string; url: string };

interface Diff {
    owner: string;
    repo: string;
    beforeRev: string;
    rev: string;
    name: string;
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

function isGitAvailable(): boolean {
    return spawnCmd(["git", "--version"]).exitCode === 0;
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
 * with CFLC_INPUT_NAME set to the flake input's name, CFLC_INPUT_PATH set to the
 * upstream checkout, and CFLC_INPUT_REV set to the SHA. CFLC_INPUT_NAME lets a single
 * build command handle whichever input is currently being bisected (e.g.
 * `--override-input "$CFLC_INPUT_NAME" "path:$CFLC_INPUT_PATH"`), instead of hardcoding
 * one input name. The command's stdout is used as the build fingerprint.
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
    if (!isGitAvailable()) {
        throw new Error("git not found in PATH \u2014 cannot run build-filter");
    }

    core.info(
        `build-filter: ${diff.owner}/${diff.repo} \u2014 evaluating ${commits.length} commit(s) between ` +
            `${diff.beforeRev} and ${diff.rev}`,
    );

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cflc-"));
    try {
        const repoPath = path.join(tmpDir, "repo");
        const repoUrl = `https://github.com/${diff.owner}/${diff.repo}`;

        core.info(`build-filter: cloning ${repoUrl}`);
        // Blobless clone: fetch tree metadata only; blobs are fetched on demand during checkout.
        const cloneResult = spawnCmd(["git", "clone", "--filter=blob:none", "--no-checkout", repoUrl, repoPath]);
        if (cloneResult.exitCode !== 0) {
            throw new Error(`Failed to clone ${repoUrl}: ${cloneResult.stderr}`);
        }

        // allShas[0] = beforeRev, allShas[1..N] = commits[0..N-1].sha. The final element
        // is always diff.rev (the actual head of the range) rather than commits[N-1].sha:
        // compareCommits' underlying API caps how many commits it returns per call, so if
        // that cap is ever hit the last entry in `commits` would not be the true head and
        // the bisect's upper endpoint would silently land short of the real range.
        const lastCommitSha = commits.length > 0 ? commits[commits.length - 1].sha : diff.beforeRev;
        const allShas =
            lastCommitSha === diff.rev
                ? [diff.beforeRev, ...commits.map((c) => c.sha)]
                : [diff.beforeRev, ...commits.map((c) => c.sha), diff.rev];

        const cmdParts = ["sh", "-c", buildCommand];

        const buildFn = (sha: string): string => {
            core.info(`build-filter: building ${sha}`);
            const checkoutResult = spawnCmd(["git", "checkout", sha], { cwd: repoPath });
            if (checkoutResult.exitCode !== 0) {
                throw new Error(`git checkout ${sha} failed: ${checkoutResult.stderr}`);
            }
            const result = spawnCmd(cmdParts, {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    CFLC_INPUT_NAME: diff.name,
                    CFLC_INPUT_PATH: repoPath,
                    CFLC_INPUT_REV: sha,
                },
            });
            if (result.exitCode !== 0) {
                throw new Error(`Build command failed at ${sha}: ${result.stderr}`);
            }
            const fingerprint = result.stdout.trim();
            core.info(`build-filter: ${sha} fingerprint: ${truncateForLog(fingerprint)}`);
            return fingerprint;
        };

        // Build at endpoints
        const outFirst = buildFn(allShas[0]);
        const outLast = buildFn(allShas[allShas.length - 1]);

        const outputs = new Map<number, string>();
        outputs.set(0, outFirst);
        outputs.set(allShas.length - 1, outLast);

        if (outFirst === outLast) {
            core.info(`build-filter: ${diff.owner}/${diff.repo} — endpoints produced identical fingerprints`);
        } else {
            core.info(`build-filter: ${diff.owner}/${diff.repo} — endpoints differ, bisecting to find boundaries`);
        }

        // Bisect to find all change boundaries
        bisect(0, allShas.length - 1, outFirst, outLast, allShas, outputs, buildFn);

        // Classify commits: commit[i] is relevant if outputs[i+1] !== outputs[i]
        const relevant: Commit[] = [];
        const irrelevant: Commit[] = [];

        // Classification itself is O(N) (one line per commit in the range, as opposed to
        // the O(log N) build/fingerprint lines above), which can mean thousands of lines
        // for a large range (e.g. a multi-day nixpkgs bump). @actions/core's debug/info
        // both write to stdout unconditionally regardless of level — only the Actions
        // runner UI hides "debug"-level lines when step debugging isn't enabled — so a
        // burst that size risks overwhelming the log stream and crashing the whole
        // action with EPIPE. Gate the write on isDebug() ourselves so a normal run emits
        // none of these at all; the final summary line below always reports the totals.
        for (let i = 0; i < commits.length; i++) {
            const isRelevant = outputs.get(i + 1) !== outputs.get(i);
            if (core.isDebug()) {
                core.debug(`build-filter: ${commits[i].sha} classified as ${isRelevant ? "relevant" : "irrelevant"}`);
            }
            if (isRelevant) {
                relevant.push(commits[i]);
            } else {
                irrelevant.push(commits[i]);
            }
        }

        core.info(
            `build-filter: ${diff.owner}/${diff.repo} — ${relevant.length} relevant, ${irrelevant.length} ` +
                `irrelevant commit(s) out of ${commits.length}`,
        );

        return { relevant, irrelevant };
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

import * as core from "@actions/core";
import * as fs from "fs";
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
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
    // Subdirectory flake and GitHub Enterprise host, when the locked node has them —
    // both feed into buildGithubFlakeRef's CFLC_INPUT_URL below.
    dir?: string;
    host?: string;
}

function spawnCmd(
    cmd: string[],
    opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { promise, resolve } = Promise.withResolvers<{ stdout: string; stderr: string; exitCode: number }>();
    const child = spawn(cmd[0], cmd.slice(1), {
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts?.env !== undefined ? { env: opts.env } : {}),
        stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
    });
    // A spawn failure (e.g. the binary isn't in PATH) never gets a `close` event
    // with a real exit code, so surface it the same way a non-zero exit would be
    // reported instead of leaving the promise unsettled.
    child.on("error", (err) => {
        resolve({ stdout, stderr: stderr || err.message, exitCode: 1 });
    });
    child.on("close", (code) => {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    return promise;
}

async function isGitAvailable(): Promise<boolean> {
    return (await spawnCmd(["git", "--version"])).exitCode === 0;
}

/**
 * Simple counting semaphore bounding how many builds run at once across an entire
 * bisection — shared across every bisect() call and the two endpoint builds, not
 * reset or re-created per recursive step.
 */
class Semaphore {
    private slots: number;
    private readonly waiters: Array<() => void> = [];

    constructor(concurrency: number) {
        this.slots = Math.max(1, concurrency);
    }

    async acquire(): Promise<void> {
        if (this.slots > 0) {
            this.slots--;
            return;
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        this.waiters.push(resolve);
        await promise;
    }

    release(): void {
        const next = this.waiters.shift();
        if (next) {
            next();
        } else {
            this.slots++;
        }
    }
}

const NIX_STATE_IGNORED_DIRS = new Set([".git", "node_modules", ".direnv", "result"]);

function collectNixStateFiles(dir: string, root: string, out: string[]): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (NIX_STATE_IGNORED_DIRS.has(entry.name)) {
            continue;
        }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectNixStateFiles(fullPath, root, out);
        } else if (entry.isFile() && (entry.name.endsWith(".nix") || entry.name === "flake.lock")) {
            out.push(path.relative(root, fullPath));
        }
    }
}

let cachedNixStateHash: string | undefined;

/**
 * Hash of every `*.nix` file and `flake.lock` under `cwd` — the complete set of
 * inputs (besides the input being bisected itself) that can change what the
 * build command evaluates. Used as part of the build-filter result cache key in
 * main.ts: a cached bisection result is only reusable while none of these files
 * have changed since it was computed. Memoized per process since these files
 * don't change mid-run; call resetNixStateHashCache() in tests that need a fresh
 * read.
 */
export function computeNixStateHash(cwd: string = process.cwd()): string {
    if (cachedNixStateHash !== undefined) {
        return cachedNixStateHash;
    }
    const files: string[] = [];
    collectNixStateFiles(cwd, cwd, files);
    files.sort();
    const hash = crypto.createHash("sha256");
    for (const relPath of files) {
        hash.update(relPath);
        hash.update("\0");
        hash.update(fs.readFileSync(path.join(cwd, relPath)));
        hash.update("\0");
    }
    cachedNixStateHash = hash.digest("hex");
    return cachedNixStateHash;
}

export function resetNixStateHashCache(): void {
    cachedNixStateHash = undefined;
}

/**
 * The `path:` fetcher (the recommended way to point `--override-input` at the
 * per-commit checkout — see the README) copies the *entire* checked-out tree into
 * the Nix store, content-addressed, on every single evaluation. Nothing dereferences
 * the previous commit's copy once the checkout moves on to the next one, so on a
 * large repo (nixpkgs is a few hundred MB to a couple GB depending on what's already
 * substituted) a bisection touching a few dozen commits can pile up tens of GB of
 * dead store paths that nothing ever reclaims until whatever runs `nix store gc`
 * next — which may be too late if a later step in the same job needs that disk. To
 * avoid that, this always runs right after every build, bounding peak usage to
 * roughly one checkout's worth per concurrent build in flight instead of the whole
 * bisection's. Safe to call from multiple concurrent builds: `nix store gc` doesn't
 * need any extra synchronization of its own — Nix's locking already handles running
 * it alongside other Nix operations.
 */
async function collectGarbage(): Promise<void> {
    const result = await spawnCmd(["nix", "store", "gc"]);
    if (result.exitCode !== 0) {
        core.warning(`build-filter: \`nix store gc\` failed (continuing anyway): ${result.stderr}`);
    }
}

/**
 * Bisect the commit range to find all boundary points where the build output changes.
 * O(k log N) builds where k = number of change points. Once the midpoint build for a
 * given range finishes, the two halves below it have no data dependency on each other
 * and run concurrently (bounded by buildFn's own concurrency limit).
 */
async function bisect(
    lo: number,
    hi: number,
    outLo: string,
    outHi: string,
    allShas: string[],
    outputs: Map<number, string>,
    buildFn: (sha: string) => Promise<string>,
): Promise<void> {
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
    const outMid = await buildFn(allShas[mid]);
    outputs.set(mid, outMid);
    await Promise.all([
        bisect(lo, mid, outLo, outMid, allShas, outputs, buildFn),
        bisect(mid, hi, outMid, outHi, allShas, outputs, buildFn),
    ]);
}

/**
 * Builds the `github:owner/repo/rev` flake reference for CFLC_INPUT_URL: Nix's own
 * `github:` fetcher pulls straight from GitHub's tarball API/CDN, so a build command
 * that overrides an input with this (instead of `path:$CFLC_INPUT_PATH` or
 * `git+file://$CFLC_INPUT_PATH?rev=$CFLC_INPUT_REV`) never needs a local checkout at
 * all. `dir`/`host` cover subdirectory flakes and GitHub Enterprise, appended as
 * `?host=...` and/or `&dir=...` (URL-encoded) when the locked node set them.
 */
function buildGithubFlakeRef(diff: Diff, sha: string): string {
    const params: string[] = [];
    if (diff.host !== undefined) {
        params.push(`host=${encodeURIComponent(diff.host)}`);
    }
    if (diff.dir !== undefined) {
        params.push(`dir=${encodeURIComponent(diff.dir)}`);
    }
    const query = params.length > 0 ? `?${params.join("&")}` : "";
    return `github:${diff.owner}/${diff.repo}/${sha}${query}`;
}

/**
 * Filter commits by whether they affect the build output.
 *
 * The upstream repo is cloned once (blobless: tree metadata only, blobs fetched on
 * demand during checkout) into a shared clone. Each build is run with
 * CFLC_INPUT_NAME set to the flake input's name, CFLC_INPUT_REV set to the SHA, and
 * CFLC_INPUT_URL set to a `github:owner/repo/rev` flake reference for that commit
 * (see buildGithubFlakeRef) — prefer overriding with this over CFLC_INPUT_PATH where
 * possible, since it fetches via Nix's own `github:` tarball fetcher instead of a
 * local checkout.
 *
 * Whether a local checkout happens at all is decided once, up front, by a simple
 * string check on `buildCommand` (constant across the whole bisection): if it
 * references CFLC_INPUT_PATH, each build gets its own isolated `git worktree` off
 * the shared clone (so multiple commits can build concurrently without their
 * checkouts stepping on each other), removed again once that build finishes,
 * whether it succeeded or threw; CFLC_INPUT_PATH is set to that worktree's path. If
 * `buildCommand` never references CFLC_INPUT_PATH, no worktree is ever created for
 * any build in the bisection — CFLC_INPUT_PATH is set to "" — and the whole
 * bisection never touches a local checkout. Either way, CFLC_INPUT_NAME lets a
 * single build command handle whichever input is currently being bisected, instead
 * of hardcoding one input name, and the command's stdout is used as the build
 * fingerprint. `nix store gc` always runs right after each build finishes (and its
 * worktree, if any, is removed), to reclaim disk before starting more work.
 *
 * Uses a bisect algorithm to minimize the number of builds: O(k log N) where
 * k = number of output change points, instead of O(N) for a linear scan. The two
 * endpoint builds, and the two halves below any given bisect midpoint, are
 * independent of each other and run concurrently, bounded by options.concurrency.
 *
 * Requires `git` in PATH; throws a descriptive error if missing.
 *
 * @param options.concurrency - Maximum number of builds running at once, each in its
 * own worktree. Defaults to 1 (fully sequential — matches the behavior before
 * concurrent builds existed). Higher values trade peak disk usage (worktree count
 * times per-checkout size) for wall-clock time on large bisections — see the
 * README's 'Build filter' section.
 */
export async function filterCommitsByBuildRelevance(
    commits: Commit[],
    diff: Diff,
    buildCommand: string,
    options?: { concurrency?: number },
): Promise<{ relevant: Commit[]; irrelevant: Commit[] }> {
    if (!(await isGitAvailable())) {
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

        // Blobless clone: fetch tree metadata only; blobs are fetched on demand during
        // checkout. Deliberately a full clone, not a partial/shallow fetch of just the
        // commits in this range: a git-init-plus-per-commit-fetch repo (no branches, no
        // full ref graph) has twice now made Nix's git+file fetcher fail against it in
        // real testing, so this sticks with the one approach that's actually held up —
        // same lesson as build-filter-skip-checkout, reverted for a related reason (see
        // the README's 'Disk space' section).
        core.info(`build-filter: cloning ${repoUrl}`);
        const cloneResult = await spawnCmd(["git", "clone", "--filter=blob:none", "--no-checkout", repoUrl, repoPath]);
        if (cloneResult.exitCode !== 0) {
            throw new Error(`Failed to clone ${repoUrl}: ${cloneResult.stderr}`);
        }

        const cmdParts = ["sh", "-c", buildCommand];
        const semaphore = new Semaphore(options?.concurrency ?? 1);

        // buildCommand doesn't vary per build, so this is decided once for the whole
        // bisection rather than per build: a local checkout (and its worktree
        // add/remove cost) is only needed when the build command actually reads
        // CFLC_INPUT_PATH.
        const needsCheckout = buildCommand.includes("CFLC_INPUT_PATH");

        // When needed, each build gets its own `git worktree` off the shared clone
        // (instead of a `git checkout` in one shared directory), so concurrent builds
        // never see each other's checkouts. The worktree is removed again once the
        // build finishes, whether it succeeded or threw, and `nix store gc` always
        // runs right after — see collectGarbage's doc comment for why.
        const buildFn = async (sha: string): Promise<string> => {
            await semaphore.acquire();
            const worktreeDir = needsCheckout ? path.join(tmpDir, `worktree-${sha}`) : undefined;
            try {
                core.info(`build-filter: building ${sha}`);
                if (worktreeDir !== undefined) {
                    const worktreeResult = await spawnCmd(["git", "worktree", "add", worktreeDir, sha], {
                        cwd: repoPath,
                    });
                    if (worktreeResult.exitCode !== 0) {
                        throw new Error(`git worktree add ${sha} failed: ${worktreeResult.stderr}`);
                    }
                }
                try {
                    const result = await spawnCmd(cmdParts, {
                        cwd: process.cwd(),
                        env: {
                            ...process.env,
                            CFLC_INPUT_NAME: diff.name,
                            // "" (not omitted) when no worktree was created, so a build
                            // command that only meant to use CFLC_INPUT_URL can't
                            // accidentally observe a stale/inherited value.
                            CFLC_INPUT_PATH: worktreeDir ?? "",
                            CFLC_INPUT_REV: sha,
                            CFLC_INPUT_URL: buildGithubFlakeRef(diff, sha),
                        },
                    });
                    if (result.exitCode !== 0) {
                        throw new Error(`Build command failed at ${sha}: ${result.stderr}`);
                    }
                    const fingerprint = result.stdout.trim();
                    core.info(`build-filter: ${sha} fingerprint: ${truncateForLog(fingerprint)}`);
                    await collectGarbage();
                    return fingerprint;
                } finally {
                    if (worktreeDir !== undefined) {
                        const removeResult = await spawnCmd(["git", "worktree", "remove", "--force", worktreeDir], {
                            cwd: repoPath,
                        });
                        if (removeResult.exitCode !== 0) {
                            core.warning(
                                `build-filter: \`git worktree remove\` failed for ${sha} (continuing anyway): ${
                                    removeResult.stderr
                                }`,
                            );
                        }
                    }
                }
            } finally {
                semaphore.release();
            }
        };

        // Build at endpoints — independent of each other, so run them concurrently
        // (still subject to the same concurrency limit as every other build).
        const [outFirst, outLast] = await Promise.all([buildFn(allShas[0]), buildFn(allShas[allShas.length - 1])]);

        const outputs = new Map<number, string>();
        outputs.set(0, outFirst);
        outputs.set(allShas.length - 1, outLast);

        if (outFirst === outLast) {
            core.info(`build-filter: ${diff.owner}/${diff.repo} — endpoints produced identical fingerprints`);
        } else {
            core.info(`build-filter: ${diff.owner}/${diff.repo} — endpoints differ, bisecting to find boundaries`);
        }

        // Bisect to find all change boundaries
        await bisect(0, allShas.length - 1, outFirst, outLast, allShas, outputs, buildFn);

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

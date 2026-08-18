import * as core from "@actions/core";
import * as fs from "fs";
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as os from "node:os";
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
    // Only "github" and "git" ever reach this pipeline (see main.ts's toLockfile)
    // — every other locked type has no commit-comparison endpoint this action can
    // call, so it never produces a Diff. buildInputFlakeRef branches on this for
    // the correct override syntax.
    type: "github" | "git";
    // The flake input's name (e.g. "nixpkgs"), exposed to the build command as
    // CFLC_INPUT_NAME so a single command can stay input-agnostic across a PR
    // that bumps more than one input.
    name: string;
    owner: string;
    repo: string;
    beforeRev: string;
    rev: string;
    // Subdirectory flake, when set — feeds into buildInputFlakeRef for either type.
    dir?: string;
    // "github" type only: a non-default (GitHub Enterprise) host.
    host?: string;
    // "git" type only: whether the locked node fetches submodules. github: has no
    // submodule support (its tarball fetcher never includes submodule content), so
    // silently coalescing a submodule-using git input into github: would desync
    // CFLC_INPUT from what flake.lock actually pins.
    submodules?: boolean;
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

// Cap on auto-detected concurrency, independent of CPU count: beyond a handful of
// concurrent builds, disk usage and GitHub API/CDN request pressure outweigh the
// marginal wall-clock win, even on a large (including self-hosted) runner.
const MAX_AUTO_CONCURRENCY = 8;

/**
 * Default build concurrency when the caller doesn't specify one: available CPUs,
 * via `os.availableParallelism()` (respects container/cgroup quotas, unlike
 * `os.cpus().length` — matters on containerized self-hosted runners), clamped to
 * `[1, MAX_AUTO_CONCURRENCY]`.
 */
function detectConcurrency(): number {
    const available = os.availableParallelism?.() ?? os.cpus().length;
    return Math.max(1, Math.min(available || 1, MAX_AUTO_CONCURRENCY));
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
 * inputs (besides the one being bisected) that can change what the build command
 * evaluates. Used in the build-filter result cache key: a cached result is only
 * reusable while none of these files have changed. Memoized per process; call
 * resetNixStateHashCache() in tests that need a fresh read.
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
 * Each build's fetched revision becomes its own content-addressed store path, and
 * nothing dereferences the previous one — a bisection over a few dozen commits on
 * a large repo can pile up tens of GB before anything reclaims it. Running this
 * after every build bounds peak usage to roughly one revision per concurrent
 * build in flight, instead of the whole bisection's. Safe to call concurrently:
 * `nix store gc` needs no extra synchronization — Nix's own locking handles it.
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
 * Builds the `CFLC_INPUT` flake reference for a commit, matching the input's
 * locked type:
 *
 * - `"github"`: `github:owner/repo/rev`, with `?host=`/`&dir=` for GitHub
 *   Enterprise/subdirectory flakes. No local checkout, no submodule support.
 * - `"git"`: `git+https://github.com/owner/repo?rev=sha`, with `&dir=`/
 *   `&submodules=1` when set. Always `https://`, even if the locked node used
 *   `ssh://` — the runner has no way to provide SSH auth, and this is safe since
 *   a `"git"`-typed `Diff` is only ever built for github.com-hosted remotes (see
 *   `toLockfile`).
 */
function buildInputFlakeRef(diff: Diff, sha: string): string {
    if (diff.type === "git") {
        const params = [`rev=${encodeURIComponent(sha)}`];
        if (diff.dir !== undefined) {
            params.push(`dir=${encodeURIComponent(diff.dir)}`);
        }
        if (diff.submodules === true) {
            params.push("submodules=1");
        }
        return `git+https://github.com/${diff.owner}/${diff.repo}?${params.join("&")}`;
    }
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
 * Filters commits by whether they affect the build output.
 *
 * Each build runs the user's shell command with `CFLC_INPUT` set to a flake
 * reference for the commit under test (see buildInputFlakeRef), e.g.
 * `nix build --override-input nixpkgs "$CFLC_INPUT"`. No local git clone or
 * checkout happens — Nix fetches directly from the upstream host. The command's
 * stdout is the build fingerprint; `nix store gc` runs after each build (see
 * collectGarbage).
 *
 * Bisects to minimize build count: O(k log N) for k change points, vs O(N) for a
 * linear scan. Endpoint builds and the two halves below any bisect midpoint are
 * independent and run concurrently, bounded by options.concurrency.
 *
 * @param options.concurrency - Max builds running at once. Defaults to an
 * auto-detected value (see detectConcurrency) rather than a fixed number, since
 * the right ceiling depends on the runner's CPU count. Higher values trade peak
 * disk usage for wall-clock time on large bisections.
 */
export async function filterCommitsByBuildRelevance(
    commits: Commit[],
    diff: Diff,
    buildCommand: string,
    options?: { concurrency?: number },
): Promise<{ relevant: Commit[]; irrelevant: Commit[] }> {
    core.info(
        `build-filter: ${diff.owner}/${diff.repo} \u2014 evaluating ${commits.length} commit(s) between ` +
            `${diff.beforeRev} and ${diff.rev}`,
    );

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
    const semaphore = new Semaphore(options?.concurrency ?? detectConcurrency());

    const buildFn = async (sha: string): Promise<string> => {
        await semaphore.acquire();
        try {
            core.info(`build-filter: building ${sha}`);
            const result = await spawnCmd(cmdParts, {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    CFLC_INPUT: buildInputFlakeRef(diff, sha),
                    CFLC_INPUT_NAME: diff.name,
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

    // Classification is O(N) (vs O(log N) for the builds above), which can mean
    // thousands of lines for a large range. core.debug/info write to stdout
    // unconditionally regardless of level, so a burst that size risks crashing the
    // action with EPIPE — gate on isDebug() ourselves so a normal run emits none of
    // this; the summary line below always reports totals.
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
}

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
    // Only "github" and "git" ever reach this action's diffable pipeline (see
    // main.ts's toLockfile) — every other flake.lock locked type (tarball, path,
    // indirect, mercurial, or a git remote hosted anywhere but github.com) has no
    // commit-comparison endpoint this action can call at all, so it never produces a
    // Diff in the first place. buildInputFlakeRef below branches on this to build the
    // correct override syntax for whichever of the two it is.
    type: "github" | "git";
    owner: string;
    repo: string;
    beforeRev: string;
    rev: string;
    // Subdirectory flake, when the locked node has one — feeds into buildInputFlakeRef's
    // CFLC_INPUT below for either type.
    dir?: string;
    // "github" type only: a non-default (GitHub Enterprise) host.
    host?: string;
    // "git" type only: whether the locked node fetches submodules. github: has no
    // submodule support at all (it fetches via GitHub's tarball API, which never
    // includes submodule content), so a git-type override must go through git+https
    // rather than being coalesced into github: when this is set — silently dropping
    // it would desync CFLC_INPUT's content from what flake.lock actually pins.
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

// Cap on auto-detected concurrency, independent of CPU count: each concurrent
// build fetches and imports its own revision into the Nix store, so beyond a
// handful in flight the marginal wall-clock win from more parallelism is
// outweighed by peak disk usage and GitHub API/CDN request pressure — this bounds
// that regardless of how many cores a large (including self-hosted) runner reports.
const MAX_AUTO_CONCURRENCY = 8;

/**
 * Picks a default build concurrency when the caller doesn't specify one: the
 * number of CPUs available to this process. Prefers `os.availableParallelism()`
 * over `os.cpus().length` — unlike the latter, it respects container/cgroup CPU
 * quotas, which matters on containerized self-hosted runners where the host may
 * report far more cores than the job actually gets. Clamped to at least 1 and at
 * most MAX_AUTO_CONCURRENCY.
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
 * Every build overrides its input with a flake reference for the commit under
 * test (see buildInputFlakeRef), and each distinct revision Nix fetches that way
 * becomes its own content-addressed store path. Nothing dereferences a previous
 * commit's copy once a build moves on to the next one, so on a large repo
 * (nixpkgs is a few hundred MB to a couple GB depending on what's already
 * substituted) a bisection touching a few dozen commits can pile up tens of GB of
 * dead store paths that nothing ever reclaims until whatever runs `nix store gc`
 * next — which may be too late if a later step in the same job needs that disk.
 * To avoid that, this always runs right after every build, bounding peak usage to
 * roughly one fetched revision's worth per concurrent build in flight instead of
 * the whole bisection's. Safe to call from multiple concurrent builds:
 * `nix store gc` doesn't need any extra synchronization of its own — Nix's
 * locking already handles running it alongside other Nix operations.
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
 * Builds the flake reference used to override an input for a given commit under
 * test (`CFLC_INPUT`), matching whichever locked type the input actually has:
 *
 * - `"github"`: `github:owner/repo/rev`, with `?host=`/`&dir=` appended
 *   (URL-encoded) for GitHub Enterprise / subdirectory flakes. Nix's own
 *   `github:` fetcher pulls straight from GitHub's tarball API/CDN — no local
 *   checkout, and no submodule support.
 * - `"git"`: `git+https://github.com/owner/repo?rev=sha`, with `&dir=`/
 *   `&submodules=1` appended when set. Always uses `https://` regardless of the
 *   locked node's original scheme — `ssh://` would need runner-side key auth this
 *   action has no way to provide — which is safe because a `"git"`-typed `Diff`
 *   is only ever constructed for github.com-hosted git remotes (see main.ts's
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
 * Filter commits by whether they affect the build output.
 *
 * Each build runs the user-provided build command with a single environment
 * variable, `CFLC_INPUT` — a flake reference for the commit under test, correct
 * for whichever locked type the input actually has (see buildInputFlakeRef) — for
 * example: `nix build --override-input nixpkgs "$CFLC_INPUT"`. Every supported
 * type is fetched by Nix's own fetchers directly from the upstream host, so no
 * local git clone or checkout of any kind happens here; builds only ever touch
 * the filesystem via whatever the build command itself does. The command's
 * stdout is used as the build fingerprint. `nix store gc` always runs right
 * after each build finishes, to reclaim disk before starting more work (see
 * collectGarbage's doc comment).
 *
 * Uses a bisect algorithm to minimize the number of builds: O(k log N) where
 * k = number of output change points, instead of O(N) for a linear scan. The two
 * endpoint builds, and the two halves below any given bisect midpoint, are
 * independent of each other and run concurrently, bounded by options.concurrency.
 *
 * @param options.concurrency - Maximum number of builds running at once. Defaults
 * to an automatically detected value (see detectConcurrency) rather than a fixed
 * number, since the right ceiling depends on the runner's own CPU count. Higher
 * values trade peak disk usage (each concurrent build fetches and imports its own
 * revision into the Nix store) for wall-clock time on large bisections — see the
 * README's 'Build filter' section.
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
}

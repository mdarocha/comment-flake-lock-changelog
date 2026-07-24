import * as core from "@actions/core";
import {
    COMMENT_TAG_PATTERN,
    GITHUB_COMMENT_MAX_LENGTH,
    compareCommits,
    getFileContentAtCommit,
    getPullRequestChangedFiles,
    getPullRequestDetails,
    getPullRequestForCommit,
    getPullRequestRefs,
    restoreCacheForRepo,
    saveCacheForRepo,
    upsertComment,
} from "~/api";
import { filterCommitsByBuildRelevance } from "~/buildFilter";

interface LockfileItem {
    type: string;
    owner: string;
    repo: string;
    rev: string;
}

type Lockfile = Record<string, LockfileItem>;
type Commit = { sha: string; message: string; url: string };

// A raw flake.lock node's `inputs` entries are either a direct reference to another
// node (by key) or a `follows` alias, encoded as the absolute input path (names, not
// node keys) from the lock file's root — see resolveInputPath below.
type RawLockNode = { inputs?: Record<string, string | string[]>; locked?: LockfileItem };
interface RawLockfile {
    root: string;
    nodes: Record<string, RawLockNode>;
}

function parseRawLockfile(content: string): RawLockfile {
    if (content === "") {
        return { root: "root", nodes: {} };
    }
    const data = JSON.parse(content);
    return { root: data.root ?? "root", nodes: data.nodes ?? {} };
}

function toLockfile(raw: RawLockfile): Lockfile {
    return Object.entries(raw.nodes)
        .filter(([key]) => key !== raw.root)
        .filter(([, node]) => node.locked?.type === "github")
        .reduce<Lockfile>((acc, [key, node]) => {
            const locked = node.locked as LockfileItem;
            acc[key] = { type: locked.type, owner: locked.owner, repo: locked.repo, rev: locked.rev };
            return acc;
        }, {});
}

/**
 * Resolve the flake input path (usable with `nix flake --override-input <path> <url>`)
 * that reaches a given flake.lock node, by walking `inputs` references starting at the
 * lock file's root. flake.lock `nodes` keys are Nix's own internal, deduplicated node
 * identifiers — e.g. the same nixpkgs input ends up keyed "nixpkgs_2", "nixpkgs_3", etc.
 * whenever it's also locked (without `follows`) by another input in the graph, such as
 * devenv/flake-parts/disko each pulling their own copy. Those keys are not valid
 * `--override-input` targets on their own; the real path is whatever name(s) the
 * consuming flake's own `inputs` (and, transitively, each input's `inputs`) use to reach
 * that node. Returns undefined if no such path exists (e.g. the node isn't reachable
 * from root at all, which shouldn't normally happen for an input flake.lock actually
 * depends on).
 */
function resolveInputPath(lockfile: RawLockfile, targetKey: string): string | undefined {
    const { nodes, root } = lockfile;
    const queue: Array<{ node: string; path: string[] }> = [{ node: root, path: [] }];
    const visited = new Set([root]);
    const followsCandidates: string[][] = [];

    while (queue.length > 0) {
        const { node, path } = queue.shift() as { node: string; path: string[] };
        for (const [name, value] of Object.entries(nodes[node]?.inputs ?? {})) {
            if (Array.isArray(value)) {
                // A `follows` entry is already an absolute path from root; check it directly
                // rather than treating it as a new subtree to descend into.
                followsCandidates.push(value);
                continue;
            }
            const nextPath = [...path, name];
            if (value === targetKey) {
                return nextPath.join("/");
            }
            if (!visited.has(value)) {
                visited.add(value);
                queue.push({ node: value, path: nextPath });
            }
        }
    }

    for (const candidate of followsCandidates) {
        if (resolveFollowsPath(nodes, root, candidate) === targetKey) {
            return candidate.join("/");
        }
    }

    return undefined;
}

function resolveFollowsPath(nodes: Record<string, RawLockNode>, root: string, path: string[]): string | undefined {
    let current = root;
    for (const segment of path) {
        const value = nodes[current]?.inputs?.[segment];
        if (value === undefined) {
            return undefined;
        }
        if (Array.isArray(value)) {
            const resolved = resolveFollowsPath(nodes, root, value);
            if (resolved === undefined) {
                return undefined;
            }
            current = resolved;
        } else {
            current = value;
        }
    }
    return current;
}

function getLockfileDiffs(
    before: Lockfile,
    after: Lockfile,
    afterRaw: RawLockfile,
): Array<LockfileItem & { beforeRev: string; name: string }> {
    return Object.entries(after)
        .filter(([_key, value]) => value.type === "github")
        .filter(([key, value]) => before[key] && before[key].rev && before[key].rev !== value.rev)
        .map(([key, value]) => {
            const name = resolveInputPath(afterRaw, key);
            if (name === undefined) {
                core.warning(
                    `Could not resolve a flake input path for flake.lock node "${key}" (${value.owner}/${value.repo}); ` +
                        "falling back to the raw node key for build-filter's CFLC_INPUT_NAME, which will likely not " +
                        "match any real --override-input target.",
                );
            }
            return {
                ...value,
                beforeRev: before[key].rev,
                name: name ?? key,
            };
        });
}

export async function run(): Promise<void> {
    const prNumber = Number(core.getInput("pull-request-number"));
    if (isNaN(prNumber) || prNumber === 0) {
        throw new Error(`Invalid pull request number: ${prNumber}`);
    }

    // Space reserved for the identity tag appended by upsertComment, so the commit-list
    // truncation below leaves room for it instead of relying on api.ts's blunter fallback truncation.
    const TAG_OVERHEAD = `\n${COMMENT_TAG_PATTERN}`.length;

    function shortSha(sha: string): string {
        return sha.slice(0, 7);
    }

    function diffHeaderBlock(diff: { owner: string; repo: string; beforeRev: string; rev: string }): string {
        return [
            `### [${diff.owner}/${diff.repo}](https://github.com/${diff.owner}/${diff.repo})`,
            "",
            `[\`${shortSha(diff.beforeRev)}\` -> \`${shortSha(diff.rev)}\`](https://github.com/${diff.owner}/${diff.repo}/compare/${diff.beforeRev}..${diff.rev})`,
        ].join("\n");
    }

    function changelogAccordionOpenBlock(): string {
        return ["", "<details><summary>Changelog</summary>", ""].join("\n");
    }

    function noCommonAncestorBlock(): string {
        return [
            "",
            "> [!NOTE]",
            "> Could not generate a detailed changelog — the commits have no common ancestor. " +
                "The repository history may have been rewritten.",
        ].join("\n");
    }

    function allIrrelevantNoteBlock(): string {
        return ["", "> [!NOTE]", "> All commits in this range produced identical build output."].join("\n");
    }

    function irrelevantAccordionOpenBlock(count: number): string {
        return [
            "",
            `<details><summary>${count} commit${count === 1 ? "" : "s"} that did not affect the build output</summary>`,
            "",
        ].join("\n");
    }

    function closingBlock(): string {
        return ["", "</details>", ""].join("\n");
    }

    function buildOmittedNote(owner: string, repo: string, beforeRev: string, rev: string, count: number): string {
        return (
            "\n\n> " +
            `${count} more commit(s) were not shown (comment size limit). ` +
            `[View full comparison](https://github.com/${owner}/${repo}/compare/${beforeRev}..${rev})\n`
        );
    }

    function commitListItem(commit: { message: string; url: string }): string {
        // if the commit message contains a @mention, we add an unicode word joiner
        // between @ and username, to avoid spamming the mentioned user.
        const commitMessage = commit.message.replace(/@/g, "@\u200D");
        const commitUrl = commit.url.replace("https://github.com", "https://redirect.github.com");
        return `- [${commitMessage}](${commitUrl})`;
    }

    async function buildCommitLine(diff: { owner: string; repo: string }, commit: Commit): Promise<string> {
        const item = commitListItem(commit);
        const pr = await getPullRequestForCommit(diff.owner, diff.repo, commit.sha);
        if (!pr) {
            return item;
        }
        // use redirect.github.com instead of github.com to avoid spamming backlinks
        const prUrl = pr.url.replace("https://github.com", "https://redirect.github.com");
        return `${item} - [![PR Icon](https://icongr.am/octicons/git-pull-request.svg?size=14&color=abb4bf) PR #${pr.id}](${prUrl})`;
    }

    const buildFilter = core.getInput("build-filter");

    const result = ["# Flake inputs changelog"];
    core.info(`Fetching changed files for PR #${prNumber}`);
    const files = await getPullRequestChangedFiles(prNumber);
    const lockfiles = files.filter((file) => file.endsWith("flake.lock"));

    if (lockfiles.length === 0) {
        core.info("No flake.lock files found in the PR");
        return;
    }

    const { base, head } = await getPullRequestRefs(prNumber);
    const prDetails = await getPullRequestDetails(prNumber);

    // Pass 1: compute all diffs across all lockfiles (no compareCommits calls yet)
    type LockfileDiff = LockfileItem & { beforeRev: string; name: string };
    const allDiffsByLockfile: Array<{ lockfile: string; diffs: LockfileDiff[] }> = [];

    for (const lockfile of lockfiles) {
        const beforeRaw = parseRawLockfile(await getFileContentAtCommit(base, lockfile));
        const afterRaw = parseRawLockfile(await getFileContentAtCommit(head, lockfile));
        const before = toLockfile(beforeRaw);
        const after = toLockfile(afterRaw);
        const diffs = getLockfileDiffs(before, after, afterRaw);
        allDiffsByLockfile.push({ lockfile, diffs });
    }

    // Dependabot skip check: if all compare URLs already appear in the PR body, no comment needed
    if (prDetails.authorLogin === "dependabot[bot]") {
        const allCompareUrls = allDiffsByLockfile.flatMap(({ diffs }) =>
            diffs.map((d) => `https://github.com/${d.owner}/${d.repo}/compare/${d.beforeRev}..${d.rev}`),
        );
        const allPresent = allCompareUrls.every((url) => prDetails.body.includes(url));
        if (allPresent) {
            core.info("Skipping comment — flake.lock changelog already present in dependabot PR description");
            return;
        }
    }

    // Pass 2: gather every input's commit list up front, split into relevant/irrelevant
    // when build-filter applies (irrelevant is always empty otherwise), plus the guaranteed
    // first commit's line. This is what lets us know each input's exact fixed cost — header,
    // accordion(s), notes — before any truncation decision is made below.
    interface GatheredDiff {
        lockfile: string;
        diff: LockfileDiff;
        relevant: Commit[];
        irrelevant: Commit[];
        firstLine: string | null;
    }
    const gathered: GatheredDiff[] = [];

    for (const { lockfile, diffs } of allDiffsByLockfile) {
        for (const diff of diffs) {
            core.info(`Checking ${diff.owner}/${diff.repo} ${diff.beforeRev} -> ${diff.rev}`);
            await restoreCacheForRepo(diff.owner, diff.repo);
            const commits = await compareCommits(diff.owner, diff.repo, diff.beforeRev, diff.rev);

            let relevant = commits;
            let irrelevant: Commit[] = [];

            if (buildFilter && commits.length > 0) {
                core.info(`Running build-filter for ${diff.owner}/${diff.repo}`);
                try {
                    const filtered = filterCommitsByBuildRelevance(commits, diff, buildFilter);
                    relevant = filtered.relevant;
                    irrelevant = filtered.irrelevant;
                } catch (e) {
                    core.warning(`build-filter failed: ${e}. Showing all commits.`);
                }
            }

            const firstLine = relevant.length > 0 ? await buildCommitLine(diff, relevant[0]) : null;
            gathered.push({ lockfile, diff, relevant, irrelevant, firstLine });
        }
    }

    // Pass 3: reserve space for everything that isn't a discretionary commit line —
    // the identity tag, every input's header/accordion(s)/closing, its no-common-ancestor
    // or all-irrelevant note if it has one, and — for inputs with relevant commits — the
    // guaranteed first commit line plus the worst-case omitted-commits note(s). This
    // guarantees no input can be truncated down to nothing without explanation, regardless
    // of how many other inputs are in the same comment.
    let reserved = TAG_OVERHEAD;
    const seenLockfiles = new Set<string>();
    for (const { lockfile, diff, relevant, irrelevant, firstLine } of gathered) {
        if (!seenLockfiles.has(lockfile)) {
            seenLockfiles.add(lockfile);
            reserved += `## ${lockfile}`.length + 1;
        }
        reserved += diffHeaderBlock(diff).length + 1;
        reserved += changelogAccordionOpenBlock().length + 1;
        reserved += closingBlock().length + 1;

        if (relevant.length === 0 && irrelevant.length === 0) {
            reserved += noCommonAncestorBlock().length + 1;
            continue;
        }

        if (relevant.length === 0) {
            reserved += allIrrelevantNoteBlock().length + 1;
        } else {
            reserved += (firstLine as string).length + 1;
            reserved += buildOmittedNote(diff.owner, diff.repo, diff.beforeRev, diff.rev, relevant.length).length + 1;
        }

        if (irrelevant.length > 0) {
            reserved += irrelevantAccordionOpenBlock(irrelevant.length).length + 1;
            reserved += closingBlock().length + 1;
            reserved += buildOmittedNote(diff.owner, diff.repo, diff.beforeRev, diff.rev, irrelevant.length).length + 1;
        }
    }
    let discretionaryBudget = Math.max(0, GITHUB_COMMENT_MAX_LENGTH - result.join("\n").length - reserved);

    // Pass 4: render, spending the discretionary budget on extra commits per input in
    // order — relevant commits first, then irrelevant ones. Each input's truncation point
    // depends only on what's left after every input's fixed cost and guaranteed first
    // commit have already been accounted for.
    let lastLockfile: string | null = null;
    for (const { lockfile, diff, relevant, irrelevant, firstLine } of gathered) {
        if (lockfile !== lastLockfile) {
            result.push(`## ${lockfile}`);
            lastLockfile = lockfile;
        }

        result.push(diffHeaderBlock(diff));

        if (relevant.length === 0 && irrelevant.length === 0) {
            result.push(changelogAccordionOpenBlock());
            result.push(closingBlock());
            result.push(noCommonAncestorBlock());
            await saveCacheForRepo(diff.owner, diff.repo);
            continue;
        }

        if (relevant.length === 0) {
            result.push(allIrrelevantNoteBlock());
        }

        result.push(changelogAccordionOpenBlock());

        let omittedRelevant = 0;
        if (relevant.length > 0) {
            result.push(firstLine as string);

            for (let i = 1; i < relevant.length; i++) {
                const commit = relevant[i];
                core.info(`Checking for PRs associated with commit ${commit.sha}`);
                const line = await buildCommitLine(diff, commit);

                if (line.length + 1 > discretionaryBudget) {
                    omittedRelevant = relevant.length - i;
                    break;
                }

                result.push(line);
                discretionaryBudget -= line.length + 1;
            }
        }

        // The irrelevant accordion (and its own omitted-commits note, placed right
        // after its closing tag) nests inside the outer accordion.
        if (irrelevant.length > 0) {
            result.push(irrelevantAccordionOpenBlock(irrelevant.length));

            let omittedIrrelevant = 0;
            for (let i = 0; i < irrelevant.length; i++) {
                const commit = irrelevant[i];
                core.info(`Checking for PRs associated with commit ${commit.sha}`);
                const line = await buildCommitLine(diff, commit);

                if (line.length + 1 > discretionaryBudget) {
                    omittedIrrelevant = irrelevant.length - i;
                    break;
                }

                result.push(line);
                discretionaryBudget -= line.length + 1;
            }

            result.push(closingBlock());

            if (omittedIrrelevant > 0) {
                result.push(buildOmittedNote(diff.owner, diff.repo, diff.beforeRev, diff.rev, omittedIrrelevant));
            }
        }

        result.push(closingBlock());

        await saveCacheForRepo(diff.owner, diff.repo);

        if (omittedRelevant > 0) {
            result.push(buildOmittedNote(diff.owner, diff.repo, diff.beforeRev, diff.rev, omittedRelevant));
        }
    }

    core.info("Posting comment to PR");
    await upsertComment(prNumber, result.join("\n"));
    core.info("Done");
}

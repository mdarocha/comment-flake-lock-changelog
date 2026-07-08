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

interface LockfileItem {
    type: string;
    owner: string;
    repo: string;
    rev: string;
}

type Lockfile = Record<string, LockfileItem>;

function parseLockfile(content: string): Lockfile {
    if (content === "") {
        return {};
    }

    const data = JSON.parse(content);
    return Object.entries<{
        locked: LockfileItem;
    }>(data.nodes)
        .filter((entry) => entry[0] !== "root")
        .filter((entry) => entry[1]["locked"]["type"] === "github")
        .map(
            (entry) =>
                [
                    entry[0],
                    {
                        type: entry[1]["locked"]["type"],
                        owner: entry[1]["locked"]["owner"],
                        repo: entry[1]["locked"]["repo"],
                        rev: entry[1]["locked"]["rev"],
                    },
                ] satisfies [string, LockfileItem],
        )
        .reduce(
            (acc, [key, value]) => ({
                [key]: value,
                ...acc,
            }),
            {},
        );
}

function getLockfileDiffs(before: Lockfile, after: Lockfile): Array<LockfileItem & { beforeRev: string }> {
    return Object.entries(after)
        .filter(([_key, value]) => value.type === "github")
        .filter(([key, value]) => before[key] && before[key].rev && before[key].rev !== value.rev)
        .map(([key, value]) => ({
            ...value,
            beforeRev: before[key].rev,
        }));
}

export async function run(): Promise<void> {
    const prNumber = Number(core.getInput("pull-request-number"));
    if (isNaN(prNumber) || prNumber === 0) {
        throw new Error(`Invalid pull request number: ${prNumber}`);
    }

    // Space reserved for the identity tag appended by upsertComment, so the commit-list
    // truncation below leaves room for it instead of relying on api.ts's blunter fallback truncation.
    const TAG_OVERHEAD = `\n${COMMENT_TAG_PATTERN}`.length;

    function diffHeaderBlock(diff: { owner: string; repo: string; beforeRev: string; rev: string }): string {
        return [
            `### [${diff.owner}/${diff.repo}](https://github.com/${diff.owner}/${diff.repo})`,
            "",
            "<details><summary>Changelog</summary>",
            "",
            `[\`${diff.beforeRev}\` -> \`${diff.rev}\`](https://github.com/${diff.owner}/${diff.repo}/compare/${diff.beforeRev}..${diff.rev})`,
        ].join("\n");
    }

    function noCommonAncestorBlock(): string {
        return [
            "",
            "> [!NOTE]",
            "> Could not generate a detailed changelog — the commits have no common ancestor. " +
                "The repository history may have been rewritten.",
        ].join("\n");
    }

    function closingBlock(): string {
        return ["", "</details>", ""].join("\n");
    }

    function buildOmittedNote(owner: string, repo: string, beforeRev: string, rev: string, count: number): string {
        return (
            "\n\n> [!NOTE]\n" +
            `> ${count} more commit(s) were not shown (comment size limit). ` +
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

    async function buildCommitLine(
        diff: { owner: string; repo: string },
        commit: { sha: string; message: string; url: string },
    ): Promise<string> {
        const item = commitListItem(commit);
        const pr = await getPullRequestForCommit(diff.owner, diff.repo, commit.sha);
        if (!pr) {
            return item;
        }
        // use redirect.github.com instead of github.com to avoid spamming backlinks
        const prUrl = pr.url.replace("https://github.com", "https://redirect.github.com");
        return `${item} - [![PR Icon](https://icongr.am/octicons/git-pull-request.svg?size=14&color=abb4bf) PR #${pr.id}](${prUrl})`;
    }

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
    type LockfileDiff = LockfileItem & { beforeRev: string };
    const allDiffsByLockfile: Array<{ lockfile: string; diffs: LockfileDiff[] }> = [];

    for (const lockfile of lockfiles) {
        const before = parseLockfile(await getFileContentAtCommit(base, lockfile));
        const after = parseLockfile(await getFileContentAtCommit(head, lockfile));
        const diffs = getLockfileDiffs(before, after);
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

    // Pass 2: gather every input's commit list (and, for the guaranteed first commit,
    // its PR association) up front. This is what lets us know each input's exact fixed
    // cost — header, accordion, notes — before any truncation decision is made below.

    // TODO cache changelogs if multiple lockfiles have the same refs and diffs
    interface GatheredDiff {
        lockfile: string;
        diff: LockfileDiff;
        commits: Array<{ sha: string; message: string; url: string }>;
        firstLine: string | null;
    }
    const gathered: GatheredDiff[] = [];

    for (const { lockfile, diffs } of allDiffsByLockfile) {
        for (const diff of diffs) {
            core.info(`Checking ${diff.owner}/${diff.repo} ${diff.beforeRev} -> ${diff.rev}`);
            await restoreCacheForRepo(diff.owner, diff.repo);
            const commits = await compareCommits(diff.owner, diff.repo, diff.beforeRev, diff.rev);
            const firstLine = commits.length > 0 ? await buildCommitLine(diff, commits[0]) : null;
            gathered.push({ lockfile, diff, commits, firstLine });
        }
    }

    // Pass 3: reserve space for everything that isn't a discretionary commit line —
    // the identity tag, every input's header/accordion/closing, its no-common-ancestor
    // note if it has one, and — for inputs with commits — the guaranteed first commit
    // line plus the worst-case omitted-commits note. This guarantees no input can be
    // truncated down to nothing without explanation, regardless of how many other
    // inputs are in the same comment.
    let reserved = TAG_OVERHEAD;
    const seenLockfiles = new Set<string>();
    for (const { lockfile, diff, commits, firstLine } of gathered) {
        if (!seenLockfiles.has(lockfile)) {
            seenLockfiles.add(lockfile);
            reserved += `## ${lockfile}`.length + 1;
        }
        reserved += diffHeaderBlock(diff).length + 1;
        reserved += closingBlock().length + 1;
        if (commits.length === 0) {
            reserved += noCommonAncestorBlock().length + 1;
        } else {
            reserved += (firstLine as string).length + 1;
            reserved += buildOmittedNote(diff.owner, diff.repo, diff.beforeRev, diff.rev, commits.length).length + 1;
        }
    }
    let discretionaryBudget = Math.max(0, GITHUB_COMMENT_MAX_LENGTH - result.join("\n").length - reserved);

    // Pass 4: render, spending the discretionary budget on extra commits per input in
    // order. Each input's truncation point depends only on what's left after every
    // input's fixed cost and guaranteed first commit have already been accounted for.
    let lastLockfile: string | null = null;
    for (const { lockfile, diff, commits, firstLine } of gathered) {
        if (lockfile !== lastLockfile) {
            result.push(`## ${lockfile}`);
            lastLockfile = lockfile;
        }

        result.push(diffHeaderBlock(diff));

        if (commits.length === 0) {
            result.push(noCommonAncestorBlock());
            result.push(closingBlock());
            await saveCacheForRepo(diff.owner, diff.repo);
            continue;
        }

        result.push(firstLine as string);

        let omitted = 0;
        for (let i = 1; i < commits.length; i++) {
            const commit = commits[i];
            core.info(`Checking for PRs associated with commit ${commit.sha}`);
            const line = await buildCommitLine(diff, commit);

            if (line.length + 1 > discretionaryBudget) {
                omitted = commits.length - i;
                break;
            }

            result.push(line);
            discretionaryBudget -= line.length + 1;
        }

        result.push(closingBlock());

        await saveCacheForRepo(diff.owner, diff.repo);

        if (omitted > 0) {
            result.push(buildOmittedNote(diff.owner, diff.repo, diff.beforeRev, diff.rev, omitted));
        }
    }

    core.info("Posting comment to PR");
    await upsertComment(prNumber, result.join("\n"));
    core.info("Done");
}

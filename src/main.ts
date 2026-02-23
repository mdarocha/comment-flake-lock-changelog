import * as core from "@actions/core";
import { writeFile } from "node:fs/promises";
import {
    compareCommits,
    getFileContentAtCommit,
    getPullRequestChangedFiles,
    getPullRequestForCommit,
    getPullRequestRefs,
} from "~/api";

async function writeResultFile(content: string): Promise<void> {
    const path = `${process.env["RUNNER_TEMP"]}/comment-flake-lock-changelog-result.md`;
    await writeFile(path, content);
}

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

    const result = ["# Flake inputs changelog"];

    core.info(`Fetching changed files for PR #${prNumber}`);
    const files = await getPullRequestChangedFiles(prNumber);
    const lockfiles = files.filter((file) => file.endsWith("flake.lock"));

    if (lockfiles.length === 0) {
        core.info("No flake.lock files found in the PR");
        return;
    }

    const { base, head } = await getPullRequestRefs(prNumber);

    // TODO cache changelogs if multiple lockfiles have the same refs and diffs
    for (const lockfile of lockfiles) {
        result.push(`## ${lockfile}`);

        const before = parseLockfile(await getFileContentAtCommit(base, lockfile));
        const after = parseLockfile(await getFileContentAtCommit(head, lockfile));
        const diffs = getLockfileDiffs(before, after);

        for (const diff of diffs) {
            core.info(`Checking ${diff.owner}/${diff.repo} ${diff.beforeRev} -> ${diff.rev}`);

            result.push(`### [${diff.owner}/${diff.repo}](https://github.com/${diff.owner}/${diff.repo})`);

            result.push("");
            result.push("<details open><summary>Changelog</summary>");
            result.push("");

            result.push(
                `[\`${diff.beforeRev}\` -> \`${diff.rev}\`](https://github.com/${diff.owner}/${diff.repo}/compare/${diff.beforeRev}..${diff.rev})`,
            );

            const commits = await compareCommits(diff.owner, diff.repo, diff.beforeRev, diff.rev);

            if (commits.length === 0) {
                result.push(
                    `> **Note:** Could not generate a detailed changelog — the commits have no common ancestor. ` +
                        `The repository history may have been rewritten.`,
                );
            }

            for (const commit of commits) {
                core.info(`Checking for PRs associated with commit ${commit.sha}`);

                // if the commit message contains a @mention, we add an unicode word joiner
                // between @ and username, to avoid spamming the mentioned user.
                const commitMessage = commit.message.replace(/@/g, "@\u200D");
                const commitUrl = commit.url.replace("https://github.com", "https://redirect.github.com");

                const commitListItem = `- [${commitMessage}](${commitUrl})`;

                const pr = await getPullRequestForCommit(diff.owner, diff.repo, commit.sha);
                if (pr) {
                    // use redirect.github.com instead of github.com to avoid spamming backlinks
                    const prUrl = pr.url.replace("https://github.com", "https://redirect.github.com");
                    result.push(
                        `${commitListItem} - [![PR Icon](https://icongr.am/octicons/git-pull-request.svg?size=14&color=abb4bf) PR #${pr.id}](${prUrl})`,
                    );
                } else {
                    result.push(commitListItem);
                }
            }

            result.push("");
            result.push("</details>");
            result.push("");
        }
    }

    core.info("Writing result file");
    await writeResultFile(result.join("\n"));
    core.info("Done");
}

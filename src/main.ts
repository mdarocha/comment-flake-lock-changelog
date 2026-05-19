import * as core from "@actions/core";
import {
    GITHUB_COMMENT_MAX_LENGTH,
    compareCommits,
    getFileContentAtCommit,
    getPullRequestChangedFiles,
    getPullRequestForCommit,
    getPullRequestRefs,
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

    // Space reserved for the identity tag appended by upsertComment and a truncation notice.
    // This covers: tag (~48 chars) + "> [!NOTE]\n> N more commit(s) ..." (~250 chars) + small buffer.
    const COMMIT_TRUNCATION_OVERHEAD = 350;

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
                result.push("> [!NOTE]");
                result.push(
                    "> Could not generate a detailed changelog — the commits have no common ancestor. " +
                        "The repository history may have been rewritten.",
                );
            }

            // Track the running body size so we can truncate at commit boundaries
            // instead of cutting mid-markdown when the GitHub comment limit is approached.
            let bodySize = result.join("\n").length;
            let omitted = 0;

            for (let i = 0; i < commits.length; i++) {
                const commit = commits[i];

                // if the commit message contains a @mention, we add an unicode word joiner
                // between @ and username, to avoid spamming the mentioned user.
                const commitMessage = commit.message.replace(/@/g, "@\u200D");
                const commitUrl = commit.url.replace("https://github.com", "https://redirect.github.com");

                const commitListItem = `- [${commitMessage}](${commitUrl})`;

                core.info(`Checking for PRs associated with commit ${commit.sha}`);
                const pr = await getPullRequestForCommit(diff.owner, diff.repo, commit.sha);
                let line: string;
                if (pr) {
                    // use redirect.github.com instead of github.com to avoid spamming backlinks
                    const prUrl = pr.url.replace("https://github.com", "https://redirect.github.com");
                    line = `${commitListItem} - [![PR Icon](https://icongr.am/octicons/git-pull-request.svg?size=14&color=abb4bf) PR #${pr.id}](${prUrl})`;
                } else {
                    line = commitListItem;
                }

                // Check if adding this commit would exceed the limit.
                if (bodySize + line.length + 1 + COMMIT_TRUNCATION_OVERHEAD > GITHUB_COMMENT_MAX_LENGTH) {
                    omitted = commits.length - i;
                    break;
                }

                result.push(line);
                bodySize += line.length + 1;
            }

            if (omitted > 0) {
                result.push("");
                result.push("> [!NOTE]");
                result.push(
                    `> ${omitted} more commit(s) were omitted. ` +
                        `[View the full comparison on GitHub](https://github.com/${diff.owner}/${diff.repo}/compare/${diff.beforeRev}..${diff.rev}).`,
                );
            }

            result.push("");
            result.push("</details>");
            result.push("");
        }
    }

    core.info("Posting comment to PR");
    await upsertComment(prNumber, result.join("\n"));
    core.info("Done");
}

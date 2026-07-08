# Comment `flake.lock` changelog

Automatically add comments to pull requests that modify flake.lock files, summarizing the changes made to the flake inputs.
This action is meant to be used as a helper to [update-flake-lock](https://github.com/DeterminateSystems/update-flake-lock).

## Inputs

| Input | Description | Default |
| :-- | :-- | :-- |
| `pull-request-number` | Id of the PR that will be analyzed by the action | none, **required** |
| `token` | Token used for authentication with Github API | `${{ github.token }}` |
| `build-filter` | Shell command to run at each upstream commit to determine build relevance. See [Build filter](#build-filter) below. | none |

## Example usage

```yaml
name: Update flake.lock

on:
  schedule:
    - cron: '0 0 * * *' # runs daily at 00:00

permissions:
  contents: write
  pull-requests: write

jobs:
  lockfile:
    name: Update lockfile
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Nix
        uses: DeterminateSystems/nix-installer-action@v16

      - name: Update flake.lock
        id: update-flake-lock
        uses: DeterminateSystems/update-flake-lock@v24
        with:
          pr-title: "Update flake.lock"
          pr-labels: automated

      - uses: mdarocha/comment-flake-lock-changelog@main
        with:
          pull-request-number: ${{ steps.update-flake-lock.outputs.pull-request-number }}
```

## Example result

![image](https://github.com/user-attachments/assets/f6a2217f-3d44-462b-a9c9-a1393206369e)

## Build filter

By default, every upstream commit between the old and new `rev` of a flake input is listed in the
changelog. For inputs like `nixpkgs`, most commits don't actually change anything that the flake
depends on (docs, unrelated packages, CI, etc.), which makes the changelog noisy. Setting
`build-filter` runs a build at a subset of the upstream commits and hides commits that didn't
change the build output behind a collapsed "did not affect the build output" section.

### How it works

For **each** flake input that changed in the lockfile (not just `nixpkgs`), the action:

1. Clones the input's upstream repository with `--filter=blob:none` (a blobless clone — cheap on
   bandwidth since blobs are fetched lazily on checkout).
2. Runs your `build-filter` command at the **first and last** commit of the range only.
   - If the two outputs are identical, every commit in between is marked irrelevant — 2 builds
     total, no further work needed.
3. If the outputs differ, the action **bisects** the range: it builds the midpoint commit, compares
   its output to both ends, and recurses only into the sub-ranges whose endpoints disagree. Ranges
   whose endpoints already agree are skipped entirely.

This costs O(k log n) builds, where `n` is the number of commits in the range and `k` is the number
of times the output actually changes — versus O(n) for a naive linear scan. Worst case (every
commit changes the output) is still bounded at ~2n builds; best case (no commit matters) is 2
builds regardless of range size.

Because the algorithm only compares the *build output*, not the diff, it works even when the
relationship between commit content and build output isn't obvious — e.g. it correctly ignores
reverts, commits that touch the source but not any derivation actually used, or refactors that
don't change what gets built.

### What your `build-filter` command must output

The command is run once per commit that the bisection needs to inspect. Its **stdout** is treated
as an opaque fingerprint of the build for that commit — the action never inspects its meaning,
only compares it for equality between commits. It should be:

- **Deterministic** for a given commit — the same commit must always produce the same fingerprint,
  otherwise the bisection will produce inconsistent (and possibly contradictory) results.
- **Sensitive to build-relevant changes, and only those** — it should change whenever something a
  consumer of the flake would care about changes (e.g. a package's contents or version), and stay
  the same otherwise (e.g. ignore embedded timestamps or build-machine-specific paths).
- A single line is enough; a Nix store path (e.g. the output of `nix build --print-out-paths`) or a
  content hash both work well.

A non-zero exit code from the command is treated as a failure of the whole build-filter step for
that input: the action logs a warning and falls back to showing every commit for that input
unfiltered, rather than guessing.

### Environment variables

The command runs as-is (no extra Nix flags are injected) in the Actions workspace — the same
directory your workflow already checked out — with these variables set:

| Variable | Description |
| :-- | :-- |
| `CFLC_INPUT_NAME` | The name of the flake input being tested, e.g. `nixpkgs`. Use this instead of hardcoding an input name so the same command works for **every** input that changed, not just one. |
| `CFLC_INPUT_PATH` | Path to the upstream checkout, at the commit currently being tested. |
| `CFLC_INPUT_REV` | The commit SHA currently checked out at `CFLC_INPUT_PATH`. |

```yaml
- uses: mdarocha/comment-flake-lock-changelog@main
  with:
    pull-request-number: ${{ github.event.pull_request.number }}
    build-filter: 'nix build --override-input "$CFLC_INPUT_NAME" "path:$CFLC_INPUT_PATH" --print-out-paths'
```

Using `$CFLC_INPUT_NAME` lets one `build-filter` command handle every input in the lockfile. A
command that hardcodes a single input name (e.g. always `--override-input nixpkgs ...`) will
silently override the wrong input whenever a *different* input's history is being bisected, which
gives meaningless or broken build results for that input.

### A note on inputs that change together

When a PR updates multiple inputs at once, each input's commit range is bisected independently, and
the build for input A is always run against the **other** inputs pinned at their final (post-update)
versions — not their pre-update versions. This mirrors what the flake will actually build with once
the whole PR is merged, so it's the right comparison for "does this commit matter for my final flake
output". It does mean that if two inputs' updates are entangled (e.g. a `nixpkgs` bump that only
builds because a `flake-utils` bump also landed), bisecting `nixpkgs` alone won't observe an
inconsistent intermediate state — the other input is never rolled back, so the fingerprint
differences you see are attributable to the input actually being bisected.

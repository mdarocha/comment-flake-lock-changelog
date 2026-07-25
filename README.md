# Comment `flake.lock` changelog

Adds a comment to pull requests that modify `flake.lock`, summarizing what changed in each flake
input. Meant as a companion to
[update-flake-lock](https://github.com/DeterminateSystems/update-flake-lock).

## Inputs

| Input | Description | Default |
| :-- | :-- | :-- |
| `pull-request-number` | Id of the PR to analyze | none, **required** |
| `token` | Token used for authentication with the GitHub API | `${{ github.token }}` |
| `build-filter` | Shell command run at each upstream commit to determine build relevance. See [Build filter](#build-filter). | none |
| `build-filter-gc` | Run `nix store gc` after every `build-filter` build to reclaim disk space. See [Build filter](#build-filter). | `false` |

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

A `flake.lock` bump often drags in commits that don't actually change what gets built, docs,
unrelated packages, or CI tweaks in a `nixpkgs` update, for instance. Setting `build-filter` builds
your flake at a handful of commits in the range and moves the ones that turn out not to affect the
output into a collapsed "did not affect the build output" section, so the changelog highlights what
actually matters.

`build-filter` is a shell command. The action runs it at a handful of upstream commits, not every
commit in the range, so it stays cheap even for large ranges, and compares its stdout between them to
tell "the build changed" from "the build didn't change." It runs once per changed input, so the same
command can apply to `nixpkgs`, `flake-utils`, or anything else in your lockfile (see
[environment variables](#environment-variables)).

### Example usage

```yaml
- uses: mdarocha/comment-flake-lock-changelog@main
  with:
    pull-request-number: ${{ github.event.pull_request.number }}
    build-filter: 'nix build --override-input "$CFLC_INPUT_NAME" "path:$CFLC_INPUT_PATH" --print-out-paths'
```

This overrides whichever input is currently being tested with the upstream checkout at the commit
under test, builds it, and prints the resulting store path, which the action uses as that commit's
fingerprint.

### Environment variables

| Variable | Description |
| :-- | :-- |
| `CFLC_INPUT_NAME` | Name of the flake input being tested, e.g. `nixpkgs`. Use it instead of hardcoding an input name, so the same `build-filter` works for every input in the lockfile. |
| `CFLC_INPUT_PATH` | Path to the upstream checkout, at the commit currently being tested. |
| `CFLC_INPUT_REV` | The commit SHA currently checked out at `CFLC_INPUT_PATH`. |

### What your command should output

The action treats your command's stdout as an opaque fingerprint. It doesn't interpret the value, it
just compares it between commits, so the output should be:

- **Deterministic.** The same commit should always produce the same fingerprint.
- **Sensitive to changes that matter, and nothing else.** It should change whenever something a
  consumer of your flake would actually notice (a package version, its contents), and stay stable
  otherwise (ignore embedded timestamps, build-machine-specific paths, etc.).

If the command exits non-zero, the action logs a warning and falls back to showing every commit for
that input, unfiltered, rather than guessing.

> [!TIP]
> Prefer a **change sentinel** over a full build where you can. A Nix output path (like
> `--print-out-paths` above) already fingerprints the entire dependency closure that went into it, so
> you don't need to wait for `nix build` to finish compiling anything. Something like
> `nix eval --raw ".#packages.<system>.default.drvPath"` (or `outPath`) computes the same fingerprint
> without building anything. It's not necessarily instant either (see [Disk space](#disk-space) for
> what importing an input into the store costs on a large repo), but it skips compiling the package,
> which for anything nontrivial is the difference that matters. Reach for an actual `nix build` only
> if you need to inspect the built result itself, for example to fingerprint a specific file inside
> the output.
>
> Keep unrelated changes out of the sentinel, or every commit will look "relevant" even when nothing
> you use actually changed. Point it at the specific output you care about (e.g.
> `packages.<system>.default`) instead of something broad like all of nixpkgs, so doc and manual
> updates elsewhere in the tree never enter your dependency closure. And avoid anything that
> deliberately stamps the exact commit into the output, like a NixOS config's `system.nixos.revision`
> set from `self.rev`. That changes on every commit by design, which defeats the filter entirely.

### Disk space

Every flake input has to become an immutable, content-addressed store path before Nix can evaluate
against it, and since each commit in the bisection genuinely has different content, the store path is
different every time too. For a large repo like nixpkgs, bisecting even a few dozen commits can pile
up tens of GB of store paths this way, and nothing reclaims that until whatever runs `nix store gc`
next, which can be too late if a later step in the same job needs the disk.

**Prefer `git+file://$CFLC_INPUT_PATH?rev=$CFLC_INPUT_REV` over `path:$CFLC_INPUT_PATH`.** This action
always checks `CFLC_INPUT_PATH` out to the commit under test before running your command, so the
needed blobs are fetched from the repo's promisor remote at that point. `path:` then makes Nix
separately re-read and re-hash that checked-out tree from the filesystem to import it into the store;
`git+file://...?rev=...` instead has Nix read the commit straight out of the repository's
already-populated object database, skipping that redundant pass:

```yaml
- uses: mdarocha/comment-flake-lock-changelog@main
  with:
    pull-request-number: ${{ github.event.pull_request.number }}
    build-filter: 'nix eval --override-input "$CFLC_INPUT_NAME" "git+file://$CFLC_INPUT_PATH?rev=$CFLC_INPUT_REV" --raw ".#packages.<system>.default.drvPath"'
```

> [!NOTE]
> Don't try to skip the internal `git checkout` yourself (say, by shallow-fetching only the one
> commit you need) to save even more disk. Nix's git fetcher is built on libgit2, which, unlike the
> `git` CLI, doesn't understand partial-clone or promisor-remote metadata and can't lazily fetch a
> missing blob on its own. It just fails with "object not found" if the blob was never fetched by
> something else first. The internal checkout is what performs that fetch, via the real `git` CLI, so
> `git+file://` can find what it needs.

Either way, set `build-filter-gc: true` to run `nix store gc` after every build, bounding peak usage
to roughly one checkout's worth instead of the whole bisection's. Only enable it if nothing else in
the job depends on Nix store paths that aren't rooted yet at the point this action runs. A store path
that was merely restored (from a build cache, say) isn't necessarily a GC root, so if this action runs
after that restore, `build-filter-gc` can delete the cache you just restored. Run this action before
restoring any build cache in the job if you turn it on.

### Result caching

Bisecting a range is expensive: a fetch plus a build per bisect step. So the action persists each
input's bisection result in a GitHub Actions cache, keyed on everything that can change its outcome:
the exact commit range and input name being tested, the `build-filter` command itself, and a hash of
every `*.nix` file and `flake.lock` in your repo. A later run reuses the cached result whenever all of
those are unchanged (re-running the action on the same PR after a comment edit, say) and re-bisects
automatically the moment any of them changes. No configuration needed.

### Inputs that change together

If a PR bumps more than one input, each is tested independently, with every other input held at its
new, post-update version for the duration. Testing `nixpkgs` always happens against the
`flake-utils` version your PR is updating to, never the one it's updating from, so you're seeing the
same build your flake will actually produce once the whole PR lands.

## Dependabot

Dependabot's own PR description already links each input's compare URL. When `build-filter` isn't set
and those URLs are already present, the action skips commenting instead of repeating them. If
`build-filter` is set, the action comments regardless: the relevant/irrelevant split is information
dependabot's description doesn't have, so it's worth posting even when the raw compare links are
redundant.

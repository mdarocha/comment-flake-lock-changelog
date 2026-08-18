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

## Supported input types

Only two locked `flake.lock` types are diffed at all — commenting, the changelog, and `build-filter`
are all limited to these:

- **`github`** — the `github:owner/repo` shorthand.
- **`git`**, when its URL resolves to a github.com repository (e.g. declared as
  `git+https://github.com/owner/repo` instead of the shorthand) — a distinct locked type despite
  pointing at the same host.

Every other locked type (`tarball`, `path`, `indirect`, a `git` remote hosted anywhere but github.com)
is skipped: this action's commit listing (`compareCommits`) is a GitHub REST API call with no
equivalent elsewhere.

## Build filter

A `flake.lock` bump often drags in commits that don't change what actually gets built — docs,
unrelated packages, CI tweaks. `build-filter` builds your flake at a handful of commits in the range
(not every commit, so it stays cheap even for large ranges) and moves the ones that don't affect the
output into a collapsed "did not affect the build output" section.

`build-filter` is a shell command; the action compares its stdout across commits to tell "changed"
from "didn't." It runs once per changed input, with `CFLC_INPUT` pointing at that input's commit each
time (see [environment variables](#environment-variables)) — write `--override-input` for whichever
input you actually want filtered. If a PR bumps more than one input, the same command runs once per
input — use `CFLC_INPUT_NAME` to keep it input-agnostic instead of hardcoding one input's name (e.g.
`nixpkgs`), which would produce a meaningless fingerprint for the others.

### Example usage

```yaml
- uses: mdarocha/comment-flake-lock-changelog@main
  with:
    pull-request-number: ${{ github.event.pull_request.number }}
    build-filter: 'nix build --override-input "$CFLC_INPUT_NAME" "$CFLC_INPUT" --print-out-paths'
```

This overrides the input currently being tested with a flake reference to the commit under test,
builds it, and prints the resulting store path, which the action uses as that commit's fingerprint.

### Environment variables

| Variable | Description |
| :-- | :-- |
| `CFLC_INPUT` | A flake reference for the commit under test, in the syntax matching the input's [locked type](#supported-input-types): `github:owner/repo/rev` (`?host=`/`&dir=` for Enterprise/subdirectory flakes) for `github`, or `git+https://github.com/owner/repo?rev=...` (`&dir=`/`&submodules=1` when set) for `git`. Pass directly to `--override-input`'s value. |
| `CFLC_INPUT_NAME` | The flake input's name (e.g. `nixpkgs`), as it appears in `flake.nix`. Pass as `--override-input`'s target so a single command works across every changed input, instead of hardcoding one. |

### What your command should output

The action treats your command's stdout as an opaque fingerprint — it just compares values between
commits, so the output should be:

- **Deterministic** — the same commit always produces the same fingerprint.
- **Sensitive to changes that matter, and nothing else** — change when a consumer of your flake would
  actually notice (a package version, its contents); stay stable otherwise (ignore timestamps,
  build-machine-specific paths).

A non-zero exit falls back to showing every commit unfiltered, rather than guessing.

> [!TIP]
> Prefer a **change sentinel** over a full build. A Nix output path (like `--print-out-paths` above)
> already fingerprints the whole dependency closure, so `nix eval --override-input nixpkgs "$CFLC_INPUT"
> --raw ".#packages.<system>.default.drvPath"` gets the same fingerprint without compiling anything
> (evaluating still imports the input into the store — see [Disk space](#disk-space)). Reach for a real
> `nix build` only if you need to inspect the built result itself.
>
> Scope the sentinel to the specific output you care about (e.g. `packages.<system>.default`), not
> something broad like all of nixpkgs, so unrelated changes (docs, other packages) don't make every
> commit look relevant. Avoid anything that stamps the commit into the output itself — like
> `system.nixos.revision` from `self.rev` — since that changes every commit by design and defeats the
> filter.

### Disk space

Each commit's flake input becomes its own content-addressed store path once Nix evaluates it, so a
bisection touching a few dozen commits on a large repo like nixpkgs can pile up tens of GB before
anything reclaims it. `nix store gc` runs right after every build, so peak usage tracks one build's
worth per concurrent build in flight, not the whole bisection's.

Run this action *before* restoring any build cache in the job: a merely-restored store path isn't
necessarily a GC root, so running after would let this GC delete the cache you just restored.

### Concurrent builds

`build-filter` builds run concurrently — the two endpoint builds, and the two halves below any bisect
midpoint, are independent of each other. Concurrency is auto-detected from the runner's available CPUs
(`os.availableParallelism()`, which respects container/cgroup quotas), capped at 8 regardless of how
many cores a large runner reports — beyond that, more parallelism trades disk/network pressure (see
[Disk space](#disk-space)) for diminishing wall-clock gains. Not configurable.

### Result caching

Bisecting is expensive (a fetch plus a build per step), so results are cached in a GitHub Actions
cache keyed on the commit range, input name, `build-filter` command, and a hash of every `*.nix`/
`flake.lock` file in your repo. A later run (e.g. after a comment edit on the same PR) reuses the
cached result until any of those change. No configuration needed.

### Inputs that change together

When a PR bumps more than one input, each is tested independently with every *other* input held at its
new, post-update version — so testing `nixpkgs` happens against the `flake-utils` version your PR is
updating *to*, not the one it's updating *from*. You're seeing the build your flake will actually
produce once the whole PR lands.

## Dependabot

Dependabot's PR description already links each input's compare URL. When `build-filter` is unset and
those links are already present, the action skips commenting to avoid repeating them — but comments
regardless when `build-filter` is set, since the relevant/irrelevant split isn't in dependabot's
description.

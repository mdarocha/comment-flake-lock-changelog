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

Only `flake.lock` nodes this action can actually diff are processed at all — everything below
(commenting, the changelog itself, and `build-filter`) is limited to these:

- **`github`** — the `github:owner/repo` shorthand (or any equivalent Nix resolves the same way).
- **`git`**, when its URL resolves to a github.com repository — e.g. declared as
  `git+https://github.com/owner/repo` or `git+ssh://git@github.com/owner/repo` instead of the
  shorthand. This is a distinct locked type despite pointing at the same host, and is recognized
  separately from `github`.

Every other locked type — `tarball`, `path`, `indirect`, `mercurial`, or a `git` input hosted anywhere
but github.com (GitLab, sourcehut, a self-hosted server) — is skipped entirely. This action's commit
listing (`compareCommits`) is a GitHub REST API call with no equivalent for those hosts or fetcher
kinds, so there's no commit range to diff or filter for them.

## Build filter

A `flake.lock` bump often drags in commits that don't actually change what gets built, docs,
unrelated packages, or CI tweaks in a `nixpkgs` update, for instance. Setting `build-filter` builds
your flake at a handful of commits in the range and moves the ones that turn out not to affect the
output into a collapsed "did not affect the build output" section, so the changelog highlights what
actually matters.

`build-filter` is a shell command. The action runs it at a handful of upstream commits, not every
commit in the range, so it stays cheap even for large ranges, and compares its stdout between them to
tell "the build changed" from "the build didn't change." It runs once per changed input in your
lockfile, with `CFLC_INPUT` pointing at that input's commit under test each time (see
[environment variables](#environment-variables)) — write your `--override-input` target for whichever
input you actually want filtered; if a PR bumps more than one input, the same command runs once per
input, so a command that only makes sense for one input (e.g. `nixpkgs`) will produce a meaningless
fingerprint for the others.

### Example usage

```yaml
- uses: mdarocha/comment-flake-lock-changelog@main
  with:
    pull-request-number: ${{ github.event.pull_request.number }}
    build-filter: 'nix build --override-input nixpkgs "$CFLC_INPUT" --print-out-paths'
```

This overrides the input currently being tested with a flake reference to the commit under test,
builds it, and prints the resulting store path, which the action uses as that commit's fingerprint.

### Environment variables

| Variable | Description |
| :-- | :-- |
| `CFLC_INPUT` | A flake reference pointing at the commit currently under test, matching whichever locked type the input actually has (see [Supported input types](#supported-input-types)): `github:owner/repo/rev` (with `?host=`/`&dir=` for GitHub Enterprise/subdirectory flakes) for `github`-type inputs, or `git+https://github.com/owner/repo?rev=...` (with `&dir=`/`&submodules=1` when set) for `git`-type inputs. Pass it directly to `--override-input`; your build command doesn't need to know or care which of the two it is. |

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
> `nix eval --override-input nixpkgs "$CFLC_INPUT" --raw ".#packages.<system>.default.drvPath"` (or
> `outPath`) computes the same fingerprint without building anything. It's not necessarily instant
> either (see [Disk space](#disk-space) for what importing an input into the store costs on a large
> repo), but it skips compiling the package, which for anything nontrivial is the difference that
> matters. Reach for an actual `nix build` only if you need to inspect the built result itself, for
> example to fingerprint a specific file inside the output.
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

`nix store gc` always runs right after every build, bounding peak usage to roughly one build's worth
of fetched/imported store paths per concurrent build in flight instead of the whole bisection's.
Nothing else in the job should depend on Nix store paths that aren't rooted yet at the point this
action runs: a store path that was merely restored (from a build cache, say) isn't necessarily a GC
root, so if this action runs after that restore, its GC pass can delete the cache you just restored.
Run this action before restoring any build cache in the job.

### Concurrent builds

`build-filter` builds run concurrently — the two endpoint builds, and the two halves below any bisect
midpoint, have no data dependency on each other. Concurrency is detected automatically from the
runner's available CPUs (`os.availableParallelism()`, which respects container/cgroup quotas rather
than a host's raw core count — relevant on containerized self-hosted runners), clamped to at most 8
regardless of how many cores a large runner reports: beyond a handful of simultaneous builds, more
parallelism trades disk and network pressure for diminishing wall-clock returns. Every build fetches
its input directly via Nix's own fetchers (see `CFLC_INPUT` above), so there's no local git clone or
checkout involved at all — more concurrent builds just means more peak disk usage, since each one
imports its own fetched revision into the Nix store (see [Disk space](#disk-space)), in exchange for
wall-clock speed on large bisections. There's no manual override for this — it isn't configurable.

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

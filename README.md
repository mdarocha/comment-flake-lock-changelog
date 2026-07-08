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

Not every upstream commit in a `flake.lock` bump actually changes what gets built — a `nixpkgs`
update, for example, usually drags in a lot of commits that only touch docs, unrelated packages, or
CI. Setting `build-filter` builds your flake at a handful of commits in the range and tucks the
commits that turned out not to affect the build output into a collapsed "did not affect the build
output" section, so the changelog highlights what actually matters.

`build-filter` is a shell command that the action runs at various upstream commits and whose output
it uses to tell "the build changed" from "the build didn't change". It's evaluated once per changed
input (so the same command applies to `nixpkgs`, `flake-utils`, or any other input in your lockfile
— see [environment variables](#environment-variables) below), and it only runs at a handful of
commits per input, not every commit in the range, so it stays cheap even for large ranges.

### Example usage

```yaml
- uses: mdarocha/comment-flake-lock-changelog@main
  with:
    pull-request-number: ${{ github.event.pull_request.number }}
    build-filter: 'nix build --override-input "$CFLC_INPUT_NAME" "path:$CFLC_INPUT_PATH" --print-out-paths'
```

This overrides whichever input is currently being tested with the upstream checkout at the commit
being tested, builds it, and prints the resulting store path — which the action uses as the
fingerprint for that commit.

### Environment variables

| Variable | Description |
| :-- | :-- |
| `CFLC_INPUT_NAME` | The name of the flake input being tested, e.g. `nixpkgs`. Use it instead of hardcoding an input name in your command, so the same `build-filter` works for every input in the lockfile. |
| `CFLC_INPUT_PATH` | Path to the upstream checkout, at the commit currently being tested. |
| `CFLC_INPUT_REV` | The commit SHA currently checked out at `CFLC_INPUT_PATH`. |

### What your command should output

The action treats your command's **stdout** as an opaque fingerprint — it doesn't inspect what the
value means, it just compares it between commits. For that comparison to be meaningful, the output
should be:

- **Deterministic** — the same commit should always produce the same fingerprint.
- **Sensitive to changes that matter, and nothing else** — it should change whenever something a
  consumer of your flake would actually notice changes (a package version, its contents, ...), and
  stay stable otherwise (ignore embedded timestamps, build-machine-specific paths, etc.).

If the command exits non-zero, the action logs a warning and falls back to showing every commit for
that input, unfiltered, rather than guessing.

> [!TIP]
> Prefer a **change sentinel** over a full build where you can. A Nix output path (like
> `--print-out-paths` above) is already a fingerprint of the *entire* dependency closure that went
> into it — you don't need to wait for `nix build` to finish compiling anything to get it. Something
> like `nix eval --raw ".#packages.<system>.default.drvPath"` (or `outPath`) computes the same
> fingerprint through evaluation alone, without building, which is typically instant even for large
> packages. Reach for an actual `nix build` only if you need to inspect the built result itself (for
> example, to fingerprint a specific file inside the output) rather than just detect that something
> changed.
>
> Keep unrelated changes out of the sentinel, or every commit will look "relevant" even when nothing
> you use actually changed. Point it at the specific output you care about (e.g.
> `packages.<system>.default`) instead of something broad like all of nixpkgs — that way doc and
> manual updates elsewhere in the tree never enter your dependency closure in the first place. And
> avoid anything that deliberately stamps the exact commit into the output, like a NixOS config's
> `system.nixos.revision` set from `self.rev` — that changes on every single commit by design, which
> defeats the filter entirely.

### Inputs that change together

If a PR bumps more than one input, each input is tested independently, with every *other* input held
at its new (post-update) version for the duration. In other words, testing `nixpkgs` always happens
against the `flake-utils` version your PR is updating *to*, never the one it's updating *from* — so
you're seeing the same build your flake will actually produce once the whole PR lands.

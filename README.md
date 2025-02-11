# Comment `flake.lock` changelog

Automatically add comments to pull requests that modify flake.lock files, summarizing the changes made to the flake inputs.
This action is meant to be used as a helper to [update-flake-lock](https://github.com/DeterminateSystems/update-flake-lock).

## Inputs

| Input | Description | Default |
| :-- | :-- | :-- |
| `pull-request-number` | Id of the PR that will be analyzed by the action | none, **required** |
| `token` | Token used for authentication with Github API | `${{ github.token }}` |

## Example usage

```yaml
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

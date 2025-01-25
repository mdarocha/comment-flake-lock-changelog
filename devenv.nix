{ pkgs, ... }:

{
  packages = [ pkgs.bun ];

  # https://devenv.sh/pre-commit-hooks/
  # pre-commit.hooks.shellcheck.enable = true;
}

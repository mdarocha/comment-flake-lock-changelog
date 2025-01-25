{ pkgs, ... }:

{
  packages = [ pkgs.bun ];

  git-hooks.hooks = {
    format = {
      enable = true;
      name = "format with prettier";
      files = "\\.(cjs|ts|json|yaml|yml)";
      entry = "bunx prettier --write";
    };

    build = {
      enable = true;
      name = "build dist";
      files = "src/*";
      entry = "bun run build";
    };
  };
}

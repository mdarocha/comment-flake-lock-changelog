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
      files = "^src/";
      entry = "bun run build";
      pass_filenames = false;
    };
  };

  enterShell = ''
    bun install
  '';

  enterTest = ''
    # Basic checks - format, lint, typescript
    bun run format:check
    bun run lint
    bun run typecheck

    # Tests
    bun test

    # Check if the dist/ file is up-to-date
    before_hash=$(sha256sum dist/** | sha256sum | cut -d ' ' -f1)
    bun run build
    after_hash=$(sha256sum dist/** | sha256sum | cut -d ' ' -f1)

    if [ "$before_hash" != "$after_hash" ]; then
      echo "dist/ is not up-to-date"
      exit 1
    else
      echo "dist/ is up-to-date"
    fi
  '';
}

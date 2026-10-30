# The development shell (ghuntley's pattern): the same nix/overlay.nix the
# flake, the image and the VM test use, so a laptop, CI and an agent sandbox
# run one toolchain. Backpressure is a failing command, not a longer prompt:
#
#   devenv shell      Node, pnpm, bd and Dolt at the pinned versions
#   devenv test       pnpm install, then `pnpm run check` and `pnpm run test`
#   git commit        Prettier on the staged files (pre-commit)
#   git push          `pnpm run check` (pre-push)
{ pkgs, lib, ... }:
{
  overlays = [ (import ./nix/overlay.nix) ];

  packages = [
    pkgs.beadsmith-nodejs
    pkgs.beadsmith-pnpm
    pkgs.beadsmith-bd
    pkgs.beadsmith-dolt
    pkgs.git
    pkgs.jq
  ];

  # pnpm is already the version package.json asks for; never let it download
  # another one.
  env.pnpm_config_manage_package_manager_versions = "false";

  enterShell = ''
    node --version
    pnpm --version
  '';

  enterTest = ''
    set -euo pipefail
    pnpm install --frozen-lockfile
    pnpm run check
    pnpm run test
  '';

  # Linked worktrees share the common .git/hooks, so every shell entry would
  # rewrite the one pre-commit hook for its own worktree. Give each linked
  # worktree its own hooks directory first (as ghuntley/overalls does); the
  # main checkout keeps .git/hooks.
  tasks."beadsmith:worktree-hooks" = {
    exec = ''
      git=${pkgs.git}/bin/git
      if dir=$($git rev-parse --path-format=absolute --git-dir 2>/dev/null) &&
         common=$($git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) &&
         [ "$dir" != "$common" ]; then
        $git config extensions.worktreeConfig true
        mkdir -p "$dir/hooks"
        [ "$($git config --worktree --get core.hooksPath || true)" = "$dir/hooks" ] ||
          $git config --worktree core.hooksPath "$dir/hooks"
      fi
    '';
    before = [ "devenv:git-hooks:install" ];
  };

  git-hooks.hooks = {
    # Prettier is the formatter (CLAUDE.md); never `vp fmt`.
    prettier-check = {
      enable = true;
      name = "prettier --check";
      entry = "${pkgs.beadsmith-pnpm}/bin/pnpm exec prettier --check --ignore-unknown";
      language = "system";
      types = [ "text" ];
    };
    beadsmith-check = {
      enable = true;
      name = "pnpm run check";
      entry = "${pkgs.beadsmith-pnpm}/bin/pnpm run check";
      language = "system";
      pass_filenames = false;
      always_run = true;
      stages = [ "pre-push" ];
    };
  };
}

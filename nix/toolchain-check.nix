# Fails when nix/overlay.nix and the repo disagree: .node-version against
# beadsmith-nodejs, package.json `packageManager` against beadsmith-pnpm. Also
# fails when the dev shell's nixpkgs (devenv.yaml, devenv.lock) is not the
# revision flake.lock pins. Evaluated, not built, so it rejects in seconds.
{ lib, runCommand, beadsmith-nodejs, beadsmith-pnpm }:
let
  node = lib.trim (builtins.readFile ../.node-version);
  pm = (lib.importJSON ../package.json).packageManager;
  flakeNixpkgs = (lib.importJSON ../flake.lock).nodes.nixpkgs.locked;
  devenvNixpkgs = (lib.importJSON ../devenv.lock).nodes.nixpkgs.locked;
  devenvUrl = "github:NixOS/nixpkgs/${flakeNixpkgs.rev}";
in
assert lib.assertMsg (beadsmith-nodejs.version == node)
  "nix/overlay.nix: beadsmith-nodejs is ${beadsmith-nodejs.version}, .node-version says ${node}";
assert lib.assertMsg (pm == "pnpm@${beadsmith-pnpm.version}")
  "nix/overlay.nix: beadsmith-pnpm is ${beadsmith-pnpm.version}, package.json says ${pm}";
assert lib.assertMsg (lib.hasInfix "url: ${devenvUrl}" (builtins.readFile ../devenv.yaml))
  "devenv.yaml: nixpkgs must be ${devenvUrl}, the revision flake.lock pins";
assert lib.assertMsg
  (devenvNixpkgs.rev == flakeNixpkgs.rev && devenvNixpkgs.narHash == flakeNixpkgs.narHash)
  "devenv.lock: nixpkgs is ${devenvNixpkgs.rev}, flake.lock pins ${flakeNixpkgs.rev}; run `devenv update nixpkgs`";
runCommand "beadsmith-toolchain" { } "touch $out"

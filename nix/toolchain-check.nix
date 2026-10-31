# Fails when nix/overlay.nix and the repo disagree: .node-version against
# beadsmith-nodejs, package.json `packageManager` against beadsmith-pnpm.
# Evaluated, not built, so it rejects in seconds.
{ lib, runCommand, beadsmith-nodejs, beadsmith-pnpm }:
let
  node = lib.trim (builtins.readFile ../.node-version);
  pm = (lib.importJSON ../package.json).packageManager;
in
assert lib.assertMsg (beadsmith-nodejs.version == node)
  "nix/overlay.nix: beadsmith-nodejs is ${beadsmith-nodejs.version}, .node-version says ${node}";
assert lib.assertMsg (pm == "pnpm@${beadsmith-pnpm.version}")
  "nix/overlay.nix: beadsmith-pnpm is ${beadsmith-pnpm.version}, package.json says ${pm}";
runCommand "beadsmith-toolchain" { } "touch $out"

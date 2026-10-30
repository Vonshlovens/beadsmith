# node_modules with `dependencies` only: what the adapter-node server imports
# at start. Built from the lockfile alone, so editing source does not reinstall.
{ lib, stdenv, autoPatchelfHook, beadsmith-nodejs, beadsmith-pnpm, pnpmConfigHook, pnpmDeps }:
stdenv.mkDerivation {
  name = "beadsmith-prod-node-modules";
  src = lib.fileset.toSource {
    root = ./..;
    fileset = lib.fileset.unions [ ../package.json ../pnpm-lock.yaml ../pnpm-workspace.yaml ];
  };
  inherit pnpmDeps;
  nativeBuildInputs = [ beadsmith-nodejs beadsmith-pnpm pnpmConfigHook ] ++ lib.optionals stdenv.isLinux [ autoPatchelfHook ];
  # libsql's native binding needs libstdc++/libgcc; autoPatchelf points it at them.
  buildInputs = lib.optionals stdenv.isLinux [ stdenv.cc.cc.lib ];
  pnpmInstallFlags = [ "--prod" ];
  dontBuild = true;
  installPhase = ''
    cp -a node_modules $out
    # pnpmConfigHook patched the .bin shebangs to the build-time Node, which
    # would pull the full nodejs package (and its dev outputs) into the image.
    # Nothing runs them there; point them back at whatever `node` is on PATH.
    grep -rlI --null '^#!/nix/store' $out | xargs -0 -r sed -i -E '1s|^#!/nix/store/[^ ]*/bin/([^ ]+)|#!/usr/bin/env \1|'
  '';
}

# Runs one package.json script against the source and the pinned pnpm store,
# offline. pnpmConfigHook installs node_modules from pnpmDeps before the build.
{ stdenv, callPackage, beadsmith-nodejs, beadsmith-pnpm, pnpmConfigHook, pnpmDeps, task }:
stdenv.mkDerivation {
  name = "beadsmith-${task}";
  src = callPackage ./source.nix { };
  inherit pnpmDeps;
  nativeBuildInputs = [ beadsmith-nodejs beadsmith-pnpm pnpmConfigHook ];
  buildPhase = ''
    runHook preBuild
    pnpm run ${task}
    runHook postBuild
  '';
  installPhase = "touch $out";
}

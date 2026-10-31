# `pnpm run build`: the adapter-node server in build/. Needs every dependency
# (Vite+, Svelte, Tailwind), none of which are in the image.
{ stdenv, callPackage, beadsmith-nodejs, beadsmith-pnpm, pnpmConfigHook, pnpmDeps }:
stdenv.mkDerivation {
  name = "beadsmith-build";
  src = callPackage ./source.nix { };
  inherit pnpmDeps;
  nativeBuildInputs = [ beadsmith-nodejs beadsmith-pnpm pnpmConfigHook ];
  buildPhase = ''
    runHook preBuild
    pnpm run build
    runHook postBuild
  '';
  installPhase = "cp -r build $out";
  # build/ is plain JS and assets; skip the fixup that rewrites its shebangs.
  dontFixup = true;
}

{ lib, stdenv, fetchPnpmDeps, beadsmith-pnpm }:
fetchPnpmDeps {
  pname = "beadsmith";
  # Lockfile and settings only: editing source must not refetch.
  src = lib.fileset.toSource {
    root = ./..;
    fileset = lib.fileset.unions [ ../package.json ../pnpm-lock.yaml ../pnpm-workspace.yaml ];
  };
  # The exact pnpm package.json asks for (nix/overlay.nix).
  pnpm = beadsmith-pnpm;
  fetcherVersion = 5;
  # One hash per system: the store holds only this platform's optional
  # packages (native binaries). After a lockfile change, `nix build
  # .#pnpmDeps` on each system prints the new hash ("got:"). aarch64-darwin
  # has not been built yet; the first build on a Mac prints it.
  hash =
    {
      x86_64-linux = "sha256-zv2LhAJyZIFB2iWqDzqAkoDrIROui5xIq+kv3MP/um8=";
      aarch64-linux = "sha256-wXDsAzrCcl+yUvLhfclylgplnCXr/uTtCNzzM/h/5xY=";
    }
    .${stdenv.hostPlatform.system} or lib.fakeHash;
}

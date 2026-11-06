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
  # One hash per system. After a lockfile change, `nix build .#pnpmDeps` on
  # each system prints the new hash ("got:"). So far both Linux systems
  # produce the same store (checked 2026-11-03 by building on each), but keep
  # an entry per system in case they diverge. aarch64-darwin has not been
  # built yet; the first build on a Mac prints it.
  hash =
    {
      x86_64-linux = "sha256-77VrEJ0OOUx9BLnqJKooaB8IJiBoLydjZdWHpmYoBs0=";
      aarch64-linux = "sha256-77VrEJ0OOUx9BLnqJKooaB8IJiBoLydjZdWHpmYoBs0=";
    }
    .${stdenv.hostPlatform.system} or lib.fakeHash;
}

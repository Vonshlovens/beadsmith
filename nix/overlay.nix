# The one toolchain definition (ghuntley's pattern): flake.nix, devenv.nix,
# the image and the VM test all take these, so laptop, CI, agent shell and
# production cannot drift. New attribute names only, so nothing else in
# nixpkgs rebuilds against them (no blast radius).
#
#   beadsmith-nodejs      Node, must equal .node-version
#   beadsmith-nodejs-slim the same Node without npm, for the image and host
#   beadsmith-pnpm        pnpm, must equal package.json `packageManager`
#   beadsmith-dolt        Dolt sql-server, the version CI and quickstart run
#   beadsmith-bd          bd, the newest release in CI's bd-compat matrix
#
# pnpm, Dolt and bd are taken from their upstream releases because nixpkgs
# 26.05 lags (pnpm 12.9.0, dolt 1.86.6, beads 1.0.3). Exit: when nixpkgs
# reaches these versions, point the attribute back at the nixpkgs package.
final: prev:
let
  inherit (final) lib stdenv;
  system = stdenv.hostPlatform.system;
  pick =
    name: table:
    table.${system} or (throw "${name}: no upstream release for ${system} in nix/overlay.nix");

  # Upstream Linux binaries link glibc dynamically.
  releaseBinary =
    {
      pname,
      version,
      src,
      binaries,
    }:
    stdenv.mkDerivation {
      inherit pname version src;
      sourceRoot = ".";
      nativeBuildInputs = lib.optionals stdenv.isLinux [ final.autoPatchelfHook ];
      dontConfigure = true;
      dontBuild = true;
      installPhase = ''
        runHook preInstall
        ${lib.concatMapStrings (b: "install -Dm755 ${b} $out/bin/${baseNameOf b}\n") binaries}
        runHook postInstall
      '';
    };

  doltTarget = pick "dolt" {
    x86_64-linux = "linux-amd64";
    aarch64-linux = "linux-arm64";
    aarch64-darwin = "darwin-arm64";
  };
  bdTarget = pick "bd" {
    x86_64-linux = "linux_amd64";
    aarch64-linux = "linux_arm64";
    aarch64-darwin = "darwin_arm64";
  };
in
{
  beadsmith-nodejs = final.nodejs_24;
  beadsmith-nodejs-slim = final.nodejs-slim_24;

  # pnpm 12 is a native binary (Rust). The npm `pnpm` package only carries a
  # launcher that downloads it on first use, which a sandbox refuses, so take
  # the binary from `@pnpm/exe.<target>` and lay it out the way pnpm's
  # install.js does: in place of the `pnpm` placeholder, next to the `dist/`
  # payload (node-gyp) it looks for.
  beadsmith-pnpm =
    let
      version = "12.15.0";
      target = pick "pnpm" {
        x86_64-linux = "linux-x64";
        aarch64-linux = "linux-arm64";
        aarch64-darwin = "darwin-arm64";
      };
      exe = final.fetchurl {
        url = "https://registry.npmjs.org/@pnpm/exe.${target}/-/exe.${target}-${version}.tgz";
        hash = pick "pnpm" {
          x86_64-linux = "sha256-QC9wRbHgWHrLFULxjTivvMtrq/PHRROU5vs9nwFgxso=";
          aarch64-linux = "sha256-gRfWXyjmJ+lJ1fxl1jNCJmMmgmpW+jdDF78T/hFmpQ4=";
          aarch64-darwin = "sha256-+rOOR5ASd2+jgQMTvYx+H9OfiD+RXBEcqYARLwaVUV4=";
        };
      };
    in
    stdenv.mkDerivation {
      pname = "pnpm";
      inherit version;
      src = final.fetchurl {
        url = "https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz";
        hash = "sha256-9Rc/YSfMUFzbNuwXcZ/lSoURxv2FYMfOtL98c+O0RYs=";
      };
      nativeBuildInputs = [ final.makeWrapper ] ++ lib.optionals stdenv.isLinux [ final.autoPatchelfHook ];
      buildInputs = lib.optionals stdenv.isLinux [ stdenv.cc.cc.lib ];
      dontConfigure = true;
      dontBuild = true;
      installPhase = ''
        runHook preInstall
        mkdir -p $out/lib/pnpm $out/bin
        cp -r . $out/lib/pnpm
        tar -xzf ${exe} -C $TMPDIR package/pnpm
        install -m755 $TMPDIR/package/pnpm $out/lib/pnpm/pnpm
        ln -s $out/lib/pnpm/pnpm $out/bin/pnpm
        makeWrapper $out/lib/pnpm/pnpm $out/bin/pnpx --add-flags dlx
        runHook postInstall
      '';
      # What fetchPnpmDeps and pnpmConfigHook read from nixpkgs' pnpm.
      passthru = {
        majorVersion = lib.versions.major version;
        nodejs-slim = final.beadsmith-nodejs-slim;
      };
      meta.mainProgram = "pnpm";
    };

  beadsmith-dolt = releaseBinary {
    pname = "dolt";
    version = "2.5.0";
    src = final.fetchurl {
      url = "https://github.com/dolthub/dolt/releases/download/v2.5.0/dolt-${doltTarget}.tar.gz";
      hash = pick "dolt" {
        x86_64-linux = "sha256:639b8042d1ea46ebf6b645a002fc787134dbe1dc02888cc51a51d1d3eb557c93";
        aarch64-linux = "sha256:ede33a0ea8fea7c6bd72246f68bf2df7d1334806c802d52b7822f912e3ca0fcf";
        aarch64-darwin = "sha256:8d120b58bfa81763d3fb032b8a0bb229cd3810bc6694116354359a2c11fe6a08";
      };
    };
    binaries = [ "dolt-${doltTarget}/bin/dolt" ];
  };

  beadsmith-bd = releaseBinary {
    pname = "bd";
    version = "1.3.1";
    src = final.fetchurl {
      url = "https://github.com/gastownhall/beads/releases/download/v1.3.1/beads_1.3.1_${bdTarget}.tar.gz";
      hash = pick "bd" {
        x86_64-linux = "sha256:3219443a9734b89b93fb16ee8d65844759fa1b3cd3cf139c606b7353cfb0715c";
        aarch64-linux = "sha256:c3b32c71a6c0cd6358a12c28272b17e6818db991da192f87df52339c222e423a";
        aarch64-darwin = "sha256:508ba807996e2b9c992c538a6f405f2fc7d2e16cf8b4e5b0d1bf9fe860367007";
      };
    };
    binaries = [ "bd" ];
  };
}

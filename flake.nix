{
  description = "Beadsmith: SvelteKit on Node 24, pnpm, Vite+. One definition, many consumers.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { self, nixpkgs, sops-nix }:
    let
      lib = nixpkgs.lib;
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      # The toolchain (Node, pnpm, Dolt, bd) comes from nix/overlay.nix, the
      # same file devenv.nix imports.
      overlay = import ./nix/overlay.nix;
      pkgsFor = lib.genAttrs systems (
        system:
        import nixpkgs {
          inherit system;
          overlays = [ overlay ];
        }
      );
      forSystems = f: lib.genAttrs systems (system: f pkgsFor.${system});

      # One host per fleet/hosts/<name>/configuration.nix, as in ghuntley/overalls:
      # the host imports this flake's modules and records which commit it runs.
      hostSystem =
        name: extraModules:
        lib.nixosSystem {
          modules = [
            sops-nix.nixosModules.sops
            self.nixosModules.beadsmith
            self.nixosModules.auto-update
            (./fleet/hosts + "/${name}/configuration.nix")
            { system.configurationRevision = self.rev or self.dirtyRev or null; }
          ]
          ++ extraModules;
        };
    in
    {
      overlays.default = overlay;

      # services.beadsmith: run the app under systemd on any NixOS host.
      nixosModules.beadsmith = import ./nix/modules/beadsmith.nix {
        packages = self.packages;
        inherit overlay;
      };
      # services.beadsmithAutoUpdate: push-to-deploy from a branch CI advances.
      nixosModules.auto-update = import ./nix/modules/auto-update.nix;

      # The real host: `nixos-rebuild switch --flake .#beads` (docs/operations/install.md).
      nixosConfigurations.beads = hostSystem "beads" [ ];
      # The same host with throwaway secrets and DHCP, for a boot test. Never
      # deploy it: its age key is in the repo.
      nixosConfigurations.beads-vm = hostSystem "beads" [ ./fleet/hosts/beads/vm-test.nix ];

      packages = forSystems (
        pkgs:
        let
          inherit (self.packages.${pkgs.stdenv.hostPlatform.system}) pnpmDeps build prodModules app;
        in
        {
          # Every package pnpm-lock.yaml names, as a pnpm store. A fixed-output
          # derivation (the only kind that may reach the network), so its hash
          # must change with the lockfile: `nix build .#pnpmDeps`, then copy the
          # hash from the mismatch error into nix/pnpm-deps.nix.
          pnpmDeps = pkgs.callPackage ./nix/pnpm-deps.nix { };
          build = pkgs.callPackage ./nix/build.nix { inherit pnpmDeps; };
          prodModules = pkgs.callPackage ./nix/prod-modules.nix { inherit pnpmDeps; };
          # The built app as /app: server, production node_modules, script files.
          app = pkgs.callPackage ./nix/app.nix { inherit build prodModules; };
          inherit (pkgs) beadsmith-pnpm beadsmith-dolt beadsmith-bd;
        }
        // nixpkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
          # OCI image: `nix build .#image`, then `docker load < result`.
          # CI pushes it as ghcr.io/<owner>/<repo>:<sha> and :latest.
          image = pkgs.callPackage ./nix/image.nix { inherit app; };
          # Boot test runner: the x86_64-linux beads-vm guest under this
          # system's QEMU (TCG on a Mac's arm64 Docker). docs/operations/install.md.
          beads-vm =
            (hostSystem "beads" [
              ./fleet/hosts/beads/vm-test.nix
              { virtualisation.vmVariant.virtualisation.host.pkgs = pkgs; }
            ]).config.system.build.vm;
        }
      );

      # The same gates CI and `devenv test` run: `pnpm run check`, `pnpm run test`.
      checks = forSystems (
        pkgs:
        let
          inherit (self.packages.${pkgs.stdenv.hostPlatform.system}) pnpmDeps;
        in
        {
          check = pkgs.callPackage ./nix/task.nix { inherit pnpmDeps; task = "check"; };
          test = pkgs.callPackage ./nix/task.nix { inherit pnpmDeps; task = "test"; };
          # The overlay pins exactly what .node-version and package.json ask for.
          toolchain = pkgs.callPackage ./nix/toolchain-check.nix { };
          # The host updater's deploy/no-op/rollback/backoff logic, against stubs.
          auto-update = pkgs.callPackage ./nix/tests/auto-update.nix { };
        }
        // lib.optionalAttrs pkgs.stdenv.isLinux {
          # NixOS VM: services.beadsmith with Dolt; /healthz answers and bd can
          # init, create and list ready work against the same server.
          vm = pkgs.testers.runNixOSTest (import ./nix/tests/beadsmith.nix { inherit self; });
        }
        // lib.optionalAttrs (pkgs.stdenv.hostPlatform.system == "x86_64-linux") {
          # The whole host closure, app included, builds.
          beads-toplevel = self.nixosConfigurations.beads.config.system.build.toplevel;
        }
      );

      devShells = forSystems (pkgs: {
        # `nix develop`; devenv.nix is the full shell (hooks, `devenv test`).
        default = pkgs.mkShell {
          packages = [
            pkgs.beadsmith-nodejs
            pkgs.beadsmith-pnpm
            pkgs.beadsmith-bd
          ];
        };
      });
    };
}

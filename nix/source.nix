# The repo without build output, caches and VCS state, so derivations that
# build from source rebuild only when a real input changes.
{ lib }:
let
  root = toString ./..;
  skip = [ "node_modules" ".git" ".svelte-kit" "build" ".deno-deploy" ".direnv" "result" ".devenv" ]
    # Host config: editing it must not rebuild the app.
    ++ [ "fleet" ".sops.yaml" ]
    # The dev shell: editing it must not rebuild the app either.
    ++ [ "devenv.nix" "devenv.yaml" "devenv.lock" ]
    ;
in
lib.cleanSourceWith {
  src = ./..;
  filter = path: _type: !(builtins.elem (lib.removePrefix "${root}/" (toString path)) skip);
}

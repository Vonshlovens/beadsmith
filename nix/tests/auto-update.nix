# Fast check for the host updater: the real script against stubs
# (nix/tests/auto-update.sh). The NixOS wiring is covered by beads-toplevel.
{ runCommand, bash, coreutils, jq, util-linux, shellcheck }:
runCommand "beadsmith-auto-update-test"
  {
    nativeBuildInputs = [ bash coreutils jq util-linux shellcheck ];
  }
  ''
    shellcheck -s bash ${../auto-update/beadsmith-auto-update.sh}
    bash ${./auto-update.sh} ${../auto-update/beadsmith-auto-update.sh}
    touch $out
  ''

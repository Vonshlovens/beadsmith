{ config, lib, pkgs, ... }:
let
  net = import ./guests/mate-net.nix;
  node = pkgs.beadsmith-nodejs;
  source = pkgs.runCommand "mate-runner-source" {} ''
    mkdir -p $out/scripts $out/src/lib
    cp ${../../../scripts/mate-runner.ts} $out/scripts/mate-runner.ts
    cp ${../../../scripts/ts-resolve.mjs} $out/scripts/ts-resolve.mjs
    cp -r ${../../../src/lib/mate-runner} $out/src/lib/mate-runner
    # The session core and hc client the runner drives chats with (ADR-0021).
    cp -r ${../../../src/lib/agent-session} $out/src/lib/agent-session
    cp -r ${../../../src/lib/hc} $out/src/lib/hc
    mkdir -p $out/src/lib/server/dispatch
    cp ${../../../src/lib/server/dispatch/sanitize.ts} $out/src/lib/server/dispatch/sanitize.ts
    cp ${../../../src/lib/mission-events.ts} $out/src/lib/mission-events.ts
    echo '{"type":"module"}' > $out/package.json
  '';
  knownHosts = pkgs.writeText "mate-known-hosts" "${net.guestAddress} ${net.hostKey}\n";
  credentials = name: "${name}:${config.sops.secrets.${name}.path}";
in {
  nixpkgs.config.allowUnfreePredicate = pkg: lib.getName pkg == "claude-code";
  nixpkgs.overlays = [ (import ../../../nix/overlay.nix) ];
  sops.defaultSopsFile = ../../secrets/forge.yaml;
  sops.age.keyFile = "/var/lib/sops-nix/key.txt";
  sops.secrets = lib.genAttrs [ "underclass-proxy-key" "underclass-ui-token" "mate-runner-secret" ] (_: {});
  services.underclass = { enable = true; bindAddress = "127.0.0.1:8080"; };
  systemd.services.underclass.serviceConfig = {
    LoadCredential = map credentials [ "underclass-proxy-key" "underclass-ui-token" ];
    ExecStart = lib.mkForce (pkgs.writeShellScript "underclass-start" ''
      export UNDERCLASS_PROXY_KEY="$(cat "$CREDENTIALS_DIRECTORY/underclass-proxy-key")"
      export UNDERCLASS_UI_TOKEN="$(cat "$CREDENTIALS_DIRECTORY/underclass-ui-token")"
      exec ${config.services.underclass.package}/bin/underclass serve --bind 127.0.0.1:8080
    '');
  };
  systemd.services.mate-model-proxy = {
    wantedBy = [ "multi-user.target" ];
    after = [ "underclass.service" "microvm-tap-interfaces@mate.service" ];
    requires = [ "microvm-tap-interfaces@mate.service" ];
    environment = {
      PROXY_BIND = net.hostAddress; PROXY_PORT = toString net.modelProxyPort;
      PROXY_KEY_FILE = "%d/underclass-proxy-key";
    };
    serviceConfig = {
      ExecStart = "${node}/bin/node ${./model-proxy.mjs}";
      LoadCredential = [ (credentials "underclass-proxy-key") ];
      DynamicUser = true; Restart = "on-failure";
      NoNewPrivileges = true; ProtectSystem = "strict"; ProtectHome = true;
      PrivateTmp = true; PrivateDevices = true;
    };
  };
  users.groups.mate-runner = {};
  users.users.mate-runner = { isSystemUser = true; group = "mate-runner"; };
  systemd.services.mate-runner = {
    wantedBy = [ "multi-user.target" ];
    after = [ "microvm@mate.service" "mate-model-proxy.service" ];
    path = [ pkgs.openssh ];
    environment = {
      MATE_RUNNER_LISTEN = "127.0.0.1:8787";
      MATE_RUNNER_SECRET_FILE = "%d/mate-runner-secret";
      MATE_RUNNER_STATE_DIR = "/var/lib/mate-runner/chats";
      MATE_AGENT_SSH = "agent@${net.guestAddress}";
      MATE_AGENT_SSH_KEY = "%d/agent-key";
      MATE_AGENT_KNOWN_HOSTS = toString knownHosts;
      MATE_AGENT_WORKDIR = "/var/lib/agent/home/work";
      MATE_AGENT_CLAUDE_CONFIG = "/var/lib/agent/home/.claude";
      MATE_AGENT_CLAUDE = "/run/current-system/sw/bin/mate-claude";
    };
    serviceConfig = {
      ExecStart = "${node}/bin/node --import ${source}/scripts/ts-resolve.mjs ${source}/scripts/mate-runner.ts";
      LoadCredential = [ (credentials "mate-runner-secret") "agent-key:/var/lib/mate-runner/ssh/agent_ed25519" ];
      User = "mate-runner"; Group = "mate-runner";
      StateDirectory = "mate-runner"; StateDirectoryMode = "0700";
      Restart = "on-failure"; RestartSec = 5; KillMode = "control-group";
      NoNewPrivileges = true; ProtectSystem = "strict"; ProtectHome = true;
      PrivateTmp = true; PrivateDevices = true; UMask = "0077";
    };
  };
}

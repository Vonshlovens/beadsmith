# NixOS VM test (pkgs.testers.runNixOSTest): services.beadsmith on a machine
# with a Dolt sql-server, both from nix/overlay.nix. Proves the property on a
# booted system, not just in a build sandbox:
#   - bd init --server creates a project on that Dolt, then create/ready work;
#   - Beadsmith starts under systemd, /healthz answers 204 on loopback;
#   - Beadsmith's read-only SQL user sees the project bd just made.
# Linux with KVM only (CI's vm job; a Mac cannot run it).
{ self }:
{ pkgs, ... }:
let
  readerPassword = "vm-test-reader-password";
in
{
  name = "beadsmith";

  nodes.machine =
    { pkgs, ... }:
    {
      imports = [ self.nixosModules.beadsmith ];
      virtualisation.memorySize = 2048;
      virtualisation.cores = 2;

      environment.systemPackages = [
        pkgs.beadsmith-bd
        pkgs.beadsmith-dolt
        pkgs.git
        pkgs.curl
        pkgs.jq
        pkgs.mariadb.client
      ];

      # The real host runs the Dolt container (fleet/hosts/beads/dolt.nix);
      # here the overlay's Dolt binary, so the test needs no registry.
      systemd.services.dolt = {
        wantedBy = [ "multi-user.target" ];
        environment.HOME = "/var/lib/dolt";
        preStart = ''
          ${pkgs.beadsmith-dolt}/bin/dolt config --global --get user.name >/dev/null 2>&1 || {
            ${pkgs.beadsmith-dolt}/bin/dolt config --global --add user.name vm-test
            ${pkgs.beadsmith-dolt}/bin/dolt config --global --add user.email vm-test@example.invalid
          }
        '';
        serviceConfig = {
          StateDirectory = "dolt";
          WorkingDirectory = "/var/lib/dolt";
          ExecStart = "${pkgs.beadsmith-dolt}/bin/dolt sql-server --host 127.0.0.1 --port 3306";
        };
      };

      services.beadsmith = {
        enable = true;
        environment = {
          BEADS_DOLT_SERVER_HOST = "127.0.0.1";
          BEADS_DOLT_SERVER_PORT = "3306";
          BEADS_DOLT_SERVER_USER = "beadsmith";
          BDX_DISPATCH_PROVIDER = "none";
        };
        credentials.dolt-password = "${pkgs.writeText "dolt-password" readerPassword}";
      };
      systemd.services.beadsmith = {
        after = [ "dolt.service" ];
        wants = [ "dolt.service" ];
      };
    };

  testScript = ''
    machine.wait_for_unit("dolt.service")
    machine.wait_for_open_port(3306)

    sql = "mysql --protocol=tcp -h 127.0.0.1 -P 3306 -u root"
    machine.succeed(
        sql + " -e \"CREATE USER 'beadsmith'@'%' IDENTIFIED BY '${readerPassword}';"
        + " GRANT SELECT ON *.* TO 'beadsmith'@'%';\""
    )

    with subtest("bd init, create and ready against the server"):
        machine.succeed(
            "mkdir -p /root/proj && cd /root/proj && git init -q"
            " && git config user.email vm@example.invalid && git config user.name vm"
        )
        bd = "cd /root/proj && BD_NON_INTERACTIVE=1 bd"
        machine.succeed(
            bd + " init --server --external --server-host 127.0.0.1 --server-port 3306"
            " --server-user root --database vmtest --prefix vm --non-interactive"
        )
        issue = machine.succeed(bd + " create --title 'Prove the VM' --type task --priority 1 --silent").strip()
        ready = machine.succeed(bd + " ready --json")
        assert issue in ready, f"{issue} not in bd ready: {ready}"

    with subtest("Beadsmith serves /healthz under systemd"):
        machine.wait_for_unit("beadsmith.service")
        code = machine.succeed(
            "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4321/healthz"
        ).strip()
        assert code == "204", f"/healthz returned {code}"

    with subtest("Beadsmith's reader sees the project bd made"):
        tables = machine.succeed(
            # This Dolt has no TLS; MariaDB 11 requires it once a password is set.
            "mysql --skip-ssl --protocol=tcp -h 127.0.0.1 -P 3306 -u beadsmith -p${readerPassword}"
            " -N -e 'SELECT id FROM vmtest.issues'"
        )
        assert issue in tables, f"{issue} not visible to the reader: {tables}"
  '';
}

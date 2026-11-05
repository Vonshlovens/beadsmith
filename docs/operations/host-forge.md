# First Mate worker operations

The runtime is defined in [ADR-0016](../../specs/decisions/0016-first-mate-worker-runtime.md).
The host name below is the fleet configuration name; supply the operator's SSH
alias and tailnet HTTPS name privately.

## Credentials and onboarding

Sops decrypts `underclass-proxy-key`, `underclass-ui-token` and
`mate-runner-secret` on the host using its existing age identity. Do not generate
replacement values during upgrades. Only systemd credentials deliver these to
the services. The existing runner SSH identity is loaded from
`/var/lib/mate-runner/ssh/agent_ed25519`; the guest host key is pinned in
`fleet/hosts/forge/guests/mate-net.nix`. Never auto-accept a changed host key.

1. Open an SSH tunnel from the operator device:
   `ssh -N -L 18080:127.0.0.1:8080 "$FORGE_SSH_TARGET"`.
2. On macOS, retrieve the existing UI token directly to the clipboard without
   displaying it: `ssh "$FORGE_SSH_TARGET" 'sudo cat /run/secrets/underclass-ui-token' | pbcopy`.
3. Open `http://127.0.0.1:18080`, paste the token, choose **Add account** and
   **Claude Code (Anthropic)**. Complete the authorization and paste-back flow
   yourself. Never send authorization codes or tokens through agent chat.
4. Clear the clipboard with `printf '' | pbcopy` and close the tunnel when done.
5. Send a signed chat turn through the runner. Confirm an actual model reply,
   a second turn in the same session, and resume after a service restart before
   treating model/session acceptance as complete.

The underclass UI must remain loopback only. The guest proxy is not an admin
access path. Owner enrollment is separate from deploying the runtime.

## Activation and rollback

Build `nix build .#nixosConfigurations.forge.config.system.build.toplevel`
on the host first. Inspect local deployment changes before updating source.
Use `sudo nixos-rebuild switch --flake .#forge`, retaining the prior system
profile generation. Do not reboot the host as part of this procedure.
Rollback with `sudo nixos-rebuild switch --rollback` if activation fails.
Guest upgrades may require `sudo systemctl restart microvm@mate`; preserve
its volume and pinned host key. Never delete or reformat the volume to upgrade.

Enable tailnet HTTPS using `sudo tailscale serve --bg --https=443 http://127.0.0.1:8787`
only after tailnet certificates are enabled. Inspect existing Serve configuration
first and preserve unrelated routes. Do not use Funnel or bind the runner to
LAN interfaces. Set `BDX_MATE_RUNNER_URL` to the HTTPS origin with **no path prefix**; the
runner handles `/v1/...` and signatures cover the full path and query.
The app requires HTTPS; certificate failure is a deployment
blocker, not a reason to weaken that requirement.

Inspect `underclass`, `mate-model-proxy`, `mate-runner`, `microvm@mate` and
`microvm-guest-firewall` services. Verify signed health, unsigned and stale
request rejection, forbidden proxy paths, empty-pool handling, and network
isolation. Check listeners and the guest firewall after activation. Keep tokens
out of command arguments, logs and test reports; remove exact temporary secret
files after any private client test.

The runner log and guest Claude state persist independently. Restarting the
runner terminates its SSH children; a subsequent turn resumes from guest state.
A running service alone does not certify successful resume or production app
integration. Dolt access and repository workers remain unimplemented here.

## Guest lifecycle smoke test

`fleet/hosts/forge/guest-lifecycle.test.mjs` runs against a deployed guest and
uses temporary host runners on loopback ports 18787 and 18788. It does not use
model credentials or change the production runner configuration. The fixture
starts two generations of detached descendants which ignore SIGTERM.

From the host checkout, install the fixture using `sudo mate-ssh`:

```sh
sudo mate-ssh 'cat > /var/lib/agent/home/work/lifecycle-fake.mjs' < fleet/hosts/forge/guests/lifecycle-fake.mjs
printf '%s\n' '#!/bin/sh' 'exec /run/current-system/sw/bin/mate-supervise /run/current-system/sw/bin/node /var/lib/agent/home/work/lifecycle-fake.mjs "$@"' | sudo mate-ssh 'cat > /var/lib/agent/home/work/lifecycle-fake; chmod 755 /var/lib/agent/home/work/lifecycle-fake'
```

Run with the pinned Node executable used by `mate-runner.service`, as root
(the existing host SSH identity is required):

```sh
sudo node --import ./scripts/ts-resolve.mjs fleet/hosts/forge/guest-lifecycle.test.mjs
```

Substitute the service's absolute Node path if Node is not on the host PATH.
The test checks delete, idle eviction, abrupt SSH client death, the runner close
hook and runner process SIGTERM. It asserts no live fixture descendants remain
and a separate chat survives each case. It removes its exact PID manifests and
host state. Afterwards remove the two fixture files:

```sh
sudo mate-ssh 'rm -f /var/lib/agent/home/work/lifecycle-fake /var/lib/agent/home/work/lifecycle-fake.mjs'
```

This verifies process cleanup without an enrolled subscription. Claude's actual
interrupt behavior and successful session resume still require model acceptance.

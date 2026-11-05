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
LAN interfaces. The app requires HTTPS; certificate failure is a deployment
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

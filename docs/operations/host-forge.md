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

The production web host reads its runner origin from the encrypted
`beads-web-mate-runner-url` setting in `fleet/secrets/beads.yaml`. Its
`beads-web-mate-runner-secret` must match `mate-runner-secret` in
`fleet/secrets/forge.yaml`. The application receives the key as a systemd
credential through `BDX_MATE_RUNNER_SECRET_FILE`; neither the secret value nor
the private origin belongs in plain Nix source. Key rotation must update and
restart both services. The web host needs tailnet HTTPS access to the runner;
it does not receive guest SSH or model credentials.

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

## Model pool route for Beadsmith

Beadsmith's console reads the pool from Underclass's admin API
([model-pool.md](../model-pool.md), rule 4 of
[ADR-0022](../../specs/decisions/0022-underclass-model-gateway.md)).
Underclass serves its UI, admin API and model surface on one loopback
listener, `127.0.0.1:8080`, and stays there. `underclass-tailnet-serve.service`
(`fleet/hosts/forge/runtime.nix`) publishes that listener with
`tailscale serve` on **tailnet HTTPS port 10000**, never with Funnel, and the
tailnet policy lets only the Beadsmith host reach that port. Port 443 stays
the mate runner's. The unit runs `tailscale serve --bg --https=10000
http://127.0.0.1:8080` and, when stopped, `tailscale serve --https=10000 off`,
which touches only that port's route. It retries every 30 seconds until
tailscaled is logged in and tailnet certificates are enabled.

Guests cannot reach the route: the guest firewall (`microvms.nix`) drops a
guest's traffic to the tailnet range and to every host port except its own
model filter, and the filter never forwards `/admin/*`.

### Tailnet grant

Add one grant to the tailnet policy, naming the Beadsmith host by the tag it
already carries (`tag:beads-sql`) and forge by its own tag or name:

```json
{ "src": ["tag:beads-sql"], "dst": ["<forge>"], "ip": ["tcp:10000"] }
```

No other source gets 10000. The operator's own devices keep using the SSH
tunnel above for Underclass's UI.

### Beadsmith settings

Beadsmith needs `BDX_UNDERCLASS_URL=https://<forge's tailnet name>:10000` (an
origin, no path) and `BDX_UNDERCLASS_UI_TOKEN_FILE`, a file holding the same
value as `underclass-ui-token` in `fleet/secrets/forge.yaml`. On host beads
both are sops values in `fleet/secrets/beads.yaml`, `beads-web-underclass-url`
and `beads-web-underclass-ui-token` ([the secrets
README](../../fleet/secrets/README.md)). Add them with `sops set` before
host beads' configuration reads them: sops-nix refuses to build a host whose
secrets name a missing key. If the UI token is rotated on forge, update the
copy on host beads and restart Beadsmith.

### Live check

After `nixos-rebuild switch` on forge, with the grant in place:

1. On forge: `systemctl is-active underclass-tailnet-serve` says `active`;
   `tailscale serve status` lists `https://<forge>:10000` proxying to
   `http://127.0.0.1:8080` and the runner's route on 443 unchanged;
   `tailscale funnel status` lists no Funnel; `ss -ltnp | grep 8080` shows
   Underclass on `127.0.0.1` only.
2. From host beads, with the token read inside the command so it never
   appears in arguments or history:

   ```sh
   sudo env TOKEN_FILE=/run/secrets/beads-web-underclass-ui-token \
     URL='https://<forge>:10000' sh -c \
     'printf "Authorization: Bearer %s\n" "$(cat "$TOKEN_FILE")" \
       | curl -sS -o /dev/null -w "%{http_code}\n" -H @- "$URL/admin/api/state"'
   ```

   prints `200`; `printf` is a shell builtin, so the token never appears in a
   process's arguments. Without the header it prints `401`.

3. From the guest: `sudo mate-ssh 'curl -sS -m 5 -o /dev/null https://<forge>:10000/; echo $?'`
   and the same against `http://10.100.0.1:8080/` and
   `https://10.100.0.1:10000/` all fail (non-zero exit, no HTTP status).
4. From another tailnet device without the grant, such as the operator's
   laptop: `curl -sS -m 5 https://<forge>:10000/` times out.
5. Open `/console/model-pool` in Beadsmith and run its
   [operator check](../model-pool.md#operator-check).

## Guest lifecycle smoke test

Each First Mate chat is interactive Claude Code in a terminal of the guest's
hc core ([ADR-0021](../../specs/decisions/0021-hc-terminal-runtime.md)). The
core runs as `hc-core.service`, a user service of the guest's `agent` account
that starts at boot (the account lingers), so a chat's CLI lives in that
service's cgroup and not in the runner's SSH session. The runner reaches it
with `ssh agent@<guest> hc connect`. Ending a chat (delete, idle eviction,
runner shutdown) kills its terminal, which ends the CLI and everything in its
session even when it ignores SIGTERM; a descendant that detaches into a
session of its own lives until `hc-core.service` stops. `agent-claude-first-run`
merges Claude Code's onboarding, folder trust and bypass-permissions answers
into the agent's state on each boot, so a launch never stops at a dialog.

After deploying a guest with hc for the first time, restart it
(`sudo systemctl restart microvm@mate`, preserving its volume) and confirm the
core runs before sending a chat:

```sh
sudo mate-ssh 'systemctl --user -M agent@ is-active hc-core.service'
```

To look at the agent's terminals, run hc as the agent the way the runner
does, with the runner's key and the pinned host key:

```sh
sudo ssh -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/var/lib/microvm-keys/known_hosts \
  -i /var/lib/mate-runner/ssh/agent_ed25519 agent@10.100.0.2 hc ls
```

`fleet/hosts/forge/guest-lifecycle.test.mjs` runs against the deployed guest
over the runner's SSH channel. It uses no model credentials and does not
change the production runner. It checks that terminals run under
`hc-core.service` with the system PATH (the fixture resolves `git`, `curl`,
`rg`, `ls` and `bash` by name), that killing a terminal ends its program and
two generations of descendants that ignore SIGTERM and SIGHUP while another
terminal survives, that a terminal outlives an abrupt kill of the SSH client
and is found again by label over a new connection, and that Claude Code
(`mate-claude`) reaches its prompt in a terminal with no first-run dialog and
ends when killed. Delete, eviction, shutdown and SIGTERM in the runner all end
a chat with that terminal kill; their logic is unit-tested against a fake hc
in `src/lib/mate-runner/`.

From the host checkout, install the fixture using `sudo mate-ssh`:

```sh
sudo mate-ssh 'cat > /var/lib/agent/home/work/lifecycle-fake.mjs; chown agent:users /var/lib/agent/home/work/lifecycle-fake.mjs' < fleet/hosts/forge/guests/lifecycle-fake.mjs
```

Run with the pinned Node executable used by `mate-runner.service`, as root
(the existing host SSH identity is required):

```sh
sudo node --import ./scripts/ts-resolve.mjs fleet/hosts/forge/guest-lifecycle.test.mjs
```

Substitute the service's absolute Node path if Node is not on the host PATH.
Each check prints `PASS`. The test removes its terminals and PID manifests.
Afterwards remove the fixture:

```sh
sudo mate-ssh 'rm -f /var/lib/agent/home/work/lifecycle-fake.mjs'
```

This verifies the guest's process lifecycle without an enrolled subscription.
A model reply, interrupt and session resume still need the operator check in
[first-mate.md](../first-mate.md#how-the-runner-runs-a-chat).

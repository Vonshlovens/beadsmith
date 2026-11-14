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

Each First Mate chat is interactive Claude Code in a terminal of an hc core
([ADR-0021](../../specs/decisions/0021-hc-terminal-runtime.md)), and each
chat has a core of its own, as a Unix identity of its own
([ADR-0023](../../specs/decisions/0023-forge-chat-isolation.md)). The core
runs in `mate-chat@<instance>.service`, where the instance is the first 24
hex digits of the SHA-256 of the chat's CLI session id; its user is
`mc-<instance>`, allocated by systemd while the unit runs (`DynamicUser=`).
The chat's home is the unit's state directory,
`/var/lib/private/mate-chats/<instance>` on the guest's `chats` volume
(owned by `nobody` on disk; systemd maps it to the chat's user inside its
unit), with the working directory `work` under it. Inside the unit,
`/var/lib/private` holds that one home: the chat sees no other chat's home
and no other chat's processes. The unit's setup step merges Claude Code's
onboarding, folder trust and bypass-permissions answers into the chat's
home on each start, so a launch never stops at a dialog.

The runner's key logs in as root but may only run the guest's `mate-chat`
helper: `connect <session id>` starts the chat's unit and runs `hc connect`
as the chat's user; `discard <session id>` stops it and removes its home.
Ending a chat's CLI (idle eviction, runner shutdown) kills its terminal,
which ends the CLI and everything in its session even when it ignores
SIGTERM; a descendant that detaches into a session of its own lives until
the chat's unit stops. Deleting a chat discards it.

After deploying this guest for the first time, restart it
(`sudo systemctl restart microvm@mate`, preserving its volume; the new
`chats.img` is created on that start). Chats from before have their
transcripts in the old shared home, which no chat sees: they start fresh
sessions on their next message. Once nothing there is wanted, remove it with
`sudo mate-ssh 'rm -rf /var/lib/agent/home'`.

To see the chats' units, and one chat's terminals as its user (`I` is the
instance):

```sh
sudo mate-ssh 'systemctl list-units "mate-chat@*"'
sudo mate-ssh 'I=<instance>; setpriv --reuid=$(id -u mc-$I) --regid=$(id -g mc-$I) --clear-groups env HOME=/run/mate-chat/$I XDG_RUNTIME_DIR=/run/mate-chat/$I hc ls'
```

`fleet/hosts/forge/guest-lifecycle.test.mjs` runs against the deployed guest
over the runner's SSH channel. It uses no model credentials and does not
change the production runner; it starts two test chats, installs its
fixture into the first, and discards both at the end. It checks that a
chat's terminals run in its own `mate-chat@` unit, as its own user, with
the system PATH (the fixture resolves `git`, `curl`, `rg`, `ls` and `bash`
by name); that killing a terminal ends its program and two generations of
descendants that ignore SIGTERM and SIGHUP while another terminal survives;
that a terminal outlives an abrupt kill of the SSH client and is found
again by label over a new connection; that the second chat cannot list,
read or write the first chat's home, reach its core's socket, see its
processes in `/proc` or signal them, or see the guest's other state; that
Claude Code (`mate-claude`) reaches its prompt in a terminal with no
first-run dialog and ends when killed; that a chat's home survives a
restart of its unit and belongs to its user afterwards; and that discarding
one chat stops it and removes its home while the other keeps running.
Delete, eviction, shutdown and SIGTERM in the runner are unit-tested
against a fake hc in `src/lib/mate-runner/`.

Run it from the host checkout with the pinned Node executable used by
`mate-runner.service`, as root (it uses the runner's SSH key and
`mate-ssh`):

```sh
sudo node --import ./scripts/ts-resolve.mjs fleet/hosts/forge/guest-lifecycle.test.mjs
```

Substitute the service's absolute Node path if Node is not on the host PATH.
Each check prints `PASS`.

This verifies the guest's process lifecycle and chat isolation without an
enrolled subscription.
A model reply, interrupt and session resume still need the operator check in
[first-mate.md](../first-mate.md#how-the-runner-runs-a-chat).

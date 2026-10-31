# Back up and restore the Beads data

A full, verified copy of every Beads database and of Beadsmith's state, and
how to put it back on a host. Day-to-day backups are the in-app backups
([docs/backups.md](../backups.md)) and the nightly restic job
([host-beads.md](host-beads.md#backups)); this is for moving to a new host or
reinstalling.

```bash
export CUT=~/backups/beads-$(date -u +%Y%m%d)
mkdir -p -m 0700 "$CUT"
b() { ssh -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 beads-admin@beads "$@"; }
# Public age recipients from .sops.yaml: the operator's and the host's.
export ADMIN_AGE=$(grep -oE '&admin age1[0-9a-z]+' .sops.yaml | cut -d' ' -f2)
export HOST_AGE=$(grep -oE '&host_beads age1[0-9a-z]+' .sops.yaml | cut -d' ' -f2)
```

## Pause writers

Stop every agent and anything else that runs `bd` against the server, and
leave it stopped until the restore is verified.

## Export and checkpoint

1. **JSONL export** of every database. The list comes from the server, so
   the names stay out of this repository. bd refuses to open a database
   whose project id differs from the checkout's, so export each one from a
   throwaway folder whose `.beads/metadata.json` names that database and has
   no `project_id`:

   ```bash
   b "sudo docker exec beads-dolt dolt sql -r csv -q 'SHOW DATABASES'" | tail -n +2 | tr -d '\r' | grep -vxE 'information_schema|mysql' > "$CUT/databases.txt"
   mkdir -p "$CUT/jsonl"
   for db in $(cat "$CUT/databases.txt"); do
     w=$(mktemp -d); mkdir "$w/.beads"
     jq --arg db "$db" 'del(.project_id) | .dolt_database=$db' .beads/metadata.json > "$w/.beads/metadata.json"
     (cd "$w" && git init -q && BD_NON_INTERACTIVE=1 bd export --all -o "$CUT/jsonl/$db.jsonl") || echo "FAILED $db"
   done
   ```

2. **A restic snapshot** with the current job (stops Dolt for a few seconds):
   `b 'sudo systemctl start restic-backups-beads-dolt.service; sudo cat /var/lib/beads-dolt-backup/last-result.json'`.

3. **Checkpoint**: per-database issue count, commit count and HEAD, then the
   SQL users. Take it twice, right before stopping; the two must match.

   ```bash
   b 'sudo bash -s' < fleet/scripts/checkpoint.sh > "$CUT/before.csv"
   b 'sudo bash -s' < fleet/scripts/checkpoint.sh | diff "$CUT/before.csv" - && echo UNCHANGED
   ```

## Stop and copy

Downtime starts here.

```bash
b 'sudo systemctl stop beadsmith.service restic-backups-beads-dolt.timer docker-beads-dolt.service'
b 'cd / && sudo tar --numeric-owner --acls --xattrs -czpf - srv/beads-dolt var/lib/beads-web' > "$CUT/beads.tar.gz"
b 'sudo du -sb /srv/beads-dolt/data /var/lib/beads-web' | tee "$CUT/sizes.txt"
```

Encrypt a copy to the operator and host age keys (the public recipients in
`.sops.yaml`) and keep it off the machine, for example in the backup bucket:

```bash
fleet/scripts/nix-docker.sh nix --quiet shell nixpkgs/nixos-26.05#age -c age -r "$ADMIN_AGE" -r "$HOST_AGE" < "$CUT/beads.tar.gz" > "$CUT/beads.tar.gz.age"
(cd "$CUT" && shasum -a 256 beads.tar.gz beads.tar.gz.age > SHA256SUMS)
```

## Verify the copy before you need it

Restore it into a local Dolt of the same version as production (the digest in
`fleet/hosts/beads/dolt.nix`) and diff the checkpoint:

```bash
mkdir -m 0700 "$CUT/verify" && tar -xzpf "$CUT/beads.tar.gz" -C "$CUT/verify" srv/beads-dolt/data
rm -f "$CUT/verify/srv/beads-dolt/data/.dolt/sql-server.info"
docker run -d --name beads-verify --platform linux/amd64 -w /var/lib/dolt -v "$CUT/verify/srv/beads-dolt/data:/var/lib/dolt" --entrypoint dolt dolthub/dolt-sql-server@sha256:<digest from dolt.nix> sql-server --host 0.0.0.0 --port 3306
sleep 15   # wait for "Server ready" in docker logs beads-verify
CONTAINER=beads-verify fleet/scripts/checkpoint.sh > "$CUT/restored-local.csv"
diff "$CUT/before.csv" "$CUT/restored-local.csv" && echo MATCH
docker rm -f beads-verify
```

Go on only with `MATCH`, a successful restic run, every export, and the
encrypted copy stored off the machine.

## Restore onto a host

On a host built from this flake ([install.md](install.md)):

```bash
b 'sudo systemctl stop beadsmith.service restic-backups-beads-dolt.timer && sudo mv /var/lib/beads-web /var/lib/beads-web.fresh'
b 'sudo tar -C / --numeric-owner -xzpf - srv/beads-dolt/data var/lib/beads-web' < "$CUT/beads.tar.gz"
b 'sudo chown -R 901:986 /var/lib/beads-web; sudo du -sb /srv/beads-dolt/data /var/lib/beads-web'; cat "$CUT/sizes.txt"
b 'sudo systemctl start docker-beads-dolt.service beadsmith.service restic-backups-beads-dolt.timer; sleep 20; systemctl is-active docker-beads-dolt beadsmith; curl -s -o /dev/null -w "healthz %{http_code}\n" http://127.0.0.1:4321/healthz'
b 'sudo bash -s' < fleet/scripts/checkpoint.sh | diff "$CUT/before.csv" - && echo MATCH
```

Sizes must match, both units `active`, `healthz 204`, then `MATCH`. Downtime
ends; let writers back in. `docker-beads-dolt` starts only when
`/srv/beads-dolt/data/.doltcfg/privileges.db` exists, so Dolt never
initialises an empty server by accident.

After a week of good runs, delete the plaintext `beads.tar.gz` and the
`verify` copy; keep the encrypted one.

# Beadsmith repository guidance

Beadsmith is a SvelteKit app (Node 24, pnpm, Vite+) that reads Beads issue
databases from a Dolt SQL server. Read the
[architecture overview](specs/README.md) and the relevant
[decisions](specs/decisions/README.md) before changing a component, and the
[product and security contract](docs/contract.md) before touching an
authority boundary.

## Architecture maintenance

- Specs and ADRs describe intent; code is reality. Search the code before
  treating a spec as implemented.
- If a change alters architecture (data plane, authority boundary, authz,
  persistence, deploy or runtime contract), update or add a numbered ADR under
  `specs/decisions/` and refresh `specs/README.md` in the same change. Follow
  the [architecture skill](.agents/skills/architecture/SKILL.md).
- Preserve accepted rationale. Corrections and implementation notes can edit
  an ADR; a material change gets a new ADR with supersession links.
- Routine fixes, copy, styling and work inside an accepted decision need no
  ADR. PR descriptions say whether architecture changed and which ADRs.

## Documentation

This repository is public. Write for someone who has only the repository.

- Put the reasoning where a reader will look: a comment, a doc under `docs/`,
  or an ADR. Link in-repo files, not things a reader cannot open.
- Never cite private references in code, docs, specs, commit messages or PR
  descriptions: issue-tracker IDs (the maintainer's Beads issues are private),
  private repositories, chat threads, or anyone's machines, hostnames,
  addresses, accounts, emails or home-directory paths. If an ID or a name
  would not help a public reader, leave it out and say what it meant.
- The maintainer's own host is declared in `fleet/` (ADR-0014). Values that
  identify it (public addresses, hostnames, bucket and database names) and
  every secret live in sops-encrypted `fleet/secrets/*.yaml`; docs name them
  by secret (for example `BEADS_PUBLIC_IPV4`), never by value.
- Run `scripts/public-scan.sh` (gitleaks, trufflehog, and a private denylist
  when one is configured) before pushing anything that touches `fleet/`,
  `docs/` or host details.
- The website in [`site/`](site/README.md) publishes `README.md` and the
  files listed in `site/src/lib/server/docs.ts` as its docs pages. It is a
  separate pnpm project: run its commands from `site/`, not the root.

## Build and test

```bash
pnpm install
pnpm run check         # svelte-check and Oxlint
pnpm run test          # Vitest
pnpm run build
devenv test            # the same gates with the Nix-pinned toolchain
nix flake check        # plus the NixOS VM test, on Linux with KVM
```

The toolchain is pinned once, in [`nix/overlay.nix`](nix/overlay.nix); keep
`.node-version` and `packageManager` in `package.json` in step with it
(`checks.toolchain` fails otherwise). After a lockfile change, refresh the
`pnpmDeps` hashes in [`nix/pnpm-deps.nix`](nix/pnpm-deps.nix).

The app needs a Dolt connection (`BEADS_DOLT_SERVER_HOST`,
`BEADS_DOLT_SERVER_USER`, `BEADS_DOLT_PASSWORD`) to show data; without one it
serves but refuses requests. Unit tests set a dummy host and never open a real
connection.

## Formatting

Prettier is the formatter (`.prettierrc`; Svelte and Tailwind class sorting
come from its plugins): `pnpm run format`, or
`pnpm exec prettier --write <files>`. **Do not run `vp fmt`**: it runs Oxfmt
with no project config and rewrites most of the repository. `vp check` only
lints. Prettier never touches `fleet/secrets/` (sops owns those files).

## Agents launched by Beadsmith

`.agents/skills/{file,tackle,comment,discuss}` are part of the product: the
dispatch prompts in `src/lib/server/dispatch/prompts.ts` point agents at them
([docs/file-tackle-dispatch.md](docs/file-tackle-dispatch.md)). Change them
with the prompts and their tests.

## Working in a shared checkout

- Other agents may be working in this repository at the same time. Keep
  unrelated work intact.
- Do not use `git stash`: worktrees share one stash, so a `stash pop` can
  apply someone else's work. Use a temporary commit or a detached worktree.
- Use non-interactive forms of commands that can prompt (`cp -f`, `rm -f`,
  `ssh -o BatchMode=yes`).

## Maintainer setup

The maintainer tracks this repository's work in Beads on a private server.
That configuration is per machine and not in git: `scripts/bd-setup.sh`
installs it (`.beads/`, `CLAUDE.local.md`, local agent hooks). Contributors
don't need it.

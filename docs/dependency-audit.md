# Dependency audit

`pnpm run audit` (`pnpm audit --audit-level=high`) is a required CI gate: it
fails on any high or critical advisory in the installed tree. This note is the
provenance for pins and overrides that keep that gate green.

Three more guards sit in front of the audit, all in `pnpm-workspace.yaml`
or CI:

- `minimumReleaseAge: 4320` (minutes, 3 days). pnpm will not resolve a package
  version younger than that, so a hijacked release has time to be reported and
  unpublished before it can enter `pnpm-lock.yaml`.
- `allowBuilds` lists the only packages whose install scripts may run (today
  esbuild). A new dependency with a build script fails the install until
  someone reviews it and adds it there as `true` or `false`.
- CI and the Dockerfile install with `pnpm install --frozen-lockfile`, so
  nothing outside `pnpm-lock.yaml` is installed there.

pnpm reads `overrides` from `pnpm-workspace.yaml`, not `package.json`. After
changing one, run `pnpm install` and confirm only the patched version is
installed (`pnpm why esbuild`). Do not delete `pnpm-lock.yaml` to apply an
override: that also bumps every unrelated caret-range package.

## Direct pins

| Package     | Range     | Why                                                                                                                                                                  |
| ----------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dompurify` | `^3.4.13` | Direct sanitizer for issue markdown (`src/lib/client/markdown.ts`). 3.4.12 and earlier are GHSA-55q2-fjhq-7xh7 (IN_PLACE hook XSS). Resolved lock version is 3.4.17. |

## Overrides (`pnpm-workspace.yaml`)

| Override  | Pin                                      | Chain                                                                                                        | Advisory                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cookie`  | `^0.7.2`                                 | Transitive cookie parser                                                                                     | Existing pin; keep.                                                                                                                                                                                                                                                                                                                                                      |
| `esbuild` | `0.28.1`                                 | `drizzle-kit@0.31.11` → deprecated `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils` → `esbuild@0.18.20` | GHSA-67mh-4wv8-2f99 (moderate). The advisory is the esbuild _dev server_ CORS bug (`<=0.24.2`). drizzle-kit still declares `@esbuild-kit`, so 0.18.20 would enter the lock. The override lifts every esbuild copy to the patched 0.28.1. Runtime does not run drizzle-kit (`drizzle.config.ts`). A later drizzle-kit that drops `@esbuild-kit` can remove this override. |
| `vite`    | `npm:@voidzero-dev/vite-plus-core@1.4.0` | Every package that peers on `vite` (SvelteKit, Tailwind, `@sveltejs/vite-plugin-svelte`)                     | Not an advisory. Vite+ ships its own Vite build; the override (also the direct `vite` devDependency) makes every plugin use that one copy. Bump it together with `vite-plus`.                                                                                                                                                                                            |

The `nanoid` override (3.3.18, GHSA-2v37-7h3g-55p8) was removed on 2026-10-27:
`postcss@8.5.31` now requires `nanoid@^3.3.20` itself.

## Known findings below the gate

`pnpm audit` reports three **low** advisories:

- Two against `@sveltejs/kit` 2.x (GHSA-pfhg-q3qv-9q6r, GHSA-27mw-82g8-phjj),
  fixed only in SvelteKit 3. The second needs prerendered pages, which
  Beadsmith does not use. They clear with the SvelteKit 3 upgrade (which also
  needs `@sveltejs/adapter-node` 6).
- `deepmerge@4.3.1` (GHSA-gcqx-w48m-w2h4, prototype poisoning), reached only
  through build tools (`@sveltejs/vite-plugin-svelte`,
  `@rollup/plugin-node-resolve`); it is not in the production install.

## How to re-check

```sh
pnpm run audit         # fail on high or critical
pnpm audit             # everything, including low and moderate
pnpm why <package>     # which copies are installed, and through what
```

If a new high finding appears, find the chain with `pnpm why`, prefer a
supported range bump, then an override only when the parent package cannot move
yet. A fix newer than 3 days cannot be installed until it ages; add it to
`minimumReleaseAgeExclude` in `pnpm-workspace.yaml` (`name@exact-version`)
only for a security fix you have reviewed, and remove the entry once it ages
out. Do not put secrets in this file.

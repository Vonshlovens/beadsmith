# Beadsmith website

The project's landing page and docs: a static SvelteKit site, built to plain
files. It is separate from the app at the repository root, with its own
`package.json`, lockfile and `pnpm-workspace.yaml`, so nothing here reaches
the app's image, Nix hashes or CI.

```sh
cd site
pnpm install
pnpm run dev       # http://localhost:5173
pnpm run check     # svelte-check
pnpm run build     # writes build/
pnpm run preview   # serves build/
```

Format with the repository's Prettier from the root:
`pnpm exec prettier --write site/src`.

## Why it lives in this repository

The docs pages are the Markdown in [`../docs`](../docs) and the
[README](../README.md), rendered at build time, so they change in the same
commit as the code they describe. Screenshots live in
[`../docs/images`](../docs/images) for the same reason; the README uses them
too.

## Docs

[`src/lib/server/docs.ts`](src/lib/server/docs.ts) lists the published files
(`DOCS`): slug, group, a one-line summary, and an optional title in place of
the file's own `# heading`. Links between published docs become site links;
links to anything else in the repository (specs, source, unpublished docs) go
to the file on GitHub. Heading anchors follow GitHub's rules, so a link that
works on GitHub works here.

The build fails when a link points at an anchor that does not exist. If a doc
edit breaks the site build, that is usually why.

## Screenshots

[`src/lib/shots.ts`](src/lib/shots.ts) lists every screenshot. Only the
parade view is a real capture so far; the others are text sketches labelled
"screenshot pending", because the UI is still changing. To replace one:

1. Start the quickstart (`docker compose -f quickstart/compose.yaml up -d --build --wait`)
   and open the view with the sample projects, in the dark theme.
2. Capture it at 2560×1600 (a 1280×800 window at 2×), like
   [`quickstart-parade.png`](../docs/images/quickstart-parade.png).
3. Save it as `docs/images/<id>.png`, import it in `shots.ts`, and set `src`,
   `width` and `height` on that shot. The sketch can go.

## Style

The app's palette (warm paper in light, onyx and ember in dark; see
[`../src/app.css`](../src/app.css)) laid out as a monospace document: one 80ch
column, 2px rules, bordered tables, `[auto]` text controls, JetBrains Mono
throughout. Tokens are at the top of [`src/app.css`](src/app.css).

## Deploying

`build/` is static: any static host works. Pages are written as
`docs/configuration.html` and linked without the extension, which GitHub
Pages, Cloudflare Pages and Netlify all resolve. To serve from a subpath (a
GitHub project page such as `https://<owner>.github.io/beadsmith`), build with
`BASE_PATH=/beadsmith pnpm run build`.

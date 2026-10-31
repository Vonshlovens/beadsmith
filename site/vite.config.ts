import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite-plus';

// The site renders ../docs/*.md and shows images from ../docs/images, so the
// dev server may read the repository root, not just site/.
const repoRoot = new URL('..', import.meta.url).pathname;

export default defineConfig({
	server: { fs: { allow: [repoRoot] } },
	// Dev only. Pre-bundling svelte/compiler (CommonJS) for SSR injects an
	// `import 'node:module'`, and resolving it reads the nearest tsconfig.json
	// that covers the file: the app's ../tsconfig.json, whose `extends` target
	// (../.svelte-kit/tsconfig.json) is missing until the app has been synced,
	// so `vp dev` fails. Node built-ins need no resolving on the server anyway.
	environments: { ssr: { optimizeDeps: { rolldownOptions: { external: [/^node:/] } } } },
	plugins: [
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			// Set BASE_PATH=/beadsmith to serve from a project page such as
			// <owner>.github.io/beadsmith; leave it unset on a domain of its own.
			paths: {
				base: (process.env.BASE_PATH ?? '') as '' | `/${string}`,
				// Absolute links, so doc HTML rendered in a load function is right on any page.
				relative: false
			}
		})
	]
});

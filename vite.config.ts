import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite-plus';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in Svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			csp: {
				mode: 'auto',
				directives: {
					'default-src': ['self'],
					'script-src': ['self'],
					'style-src': ['self', 'unsafe-inline'],
					'img-src': ['self', 'data:'],
					'font-src': ['self'],
					'connect-src': ['self'],
					'object-src': ['none'],
					'base-uri': ['self'],
					'frame-ancestors': ['none'],
					'form-action': ['self']
				}
			}
		})
	],
	// adapter-node marks every runtime dependency external to the server build,
	// and an external is resolved with Node's conditions. tw-animate-css is CSS
	// that app.css imports; it exports only a `style` condition, so as an
	// external Tailwind cannot resolve it. Listed here, the adapter leaves it in.
	ssr: { noExternal: ['tw-animate-css'] },
	// Prettier stays the formatter (`pnpm run format`): it formats Svelte files
	// and sorts Tailwind classes. `vp check` runs Oxlint only.
	check: { fmt: false }
});

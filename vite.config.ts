import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite-plus';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	// Prettier stays the formatter (`pnpm run format`): it formats Svelte files
	// and sorts Tailwind classes. `vp check` runs Oxlint only.
	check: { fmt: false }
});

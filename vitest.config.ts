import { defineConfig } from 'vite-plus';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts'],
		globals: false,
		// Vitest blanks CSS imports by default, `?raw` included. The app
		// libraries inline the design tokens from app.css as raw text
		// (src/lib/server/grown/app-libraries.ts), so let that one through.
		css: { include: [/src\/app\.css/] },
		// Loopback bind so checkBindPolicy does not demand BDX_AUTH_TOKEN.
		// A dummy Dolt host satisfies the remote-service gate unless the process
		// already has one (so BDX_LIVE=1 can still target a real server).
		env: {
			HOST: '127.0.0.1',
			BEADS_DOLT_SERVER_HOST: process.env.BEADS_DOLT_SERVER_HOST ?? 'dolt.test'
		}
	},
	resolve: {
		alias: {
			// SvelteKit generates this module during a build, so a plain vitest run
			// cannot resolve it. The tests here are server-side by definition.
			'$app/env': new URL('./src/lib/test/app-env.ts', import.meta.url).pathname
		}
	}
});

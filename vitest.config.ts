import { defineConfig } from 'vite-plus';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts'],
		globals: false,
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
			$lib: new URL('./src/lib', import.meta.url).pathname,
			// SvelteKit generates this module during a build, so a plain vitest run
			// cannot resolve it. The tests here are server-side by definition.
			'$app/environment': new URL('./src/lib/test/app-environment.ts', import.meta.url).pathname
		}
	}
});

/**
 * Let Node run the host-side scripts straight from source. Node strips types
 * on its own, but src/ imports its siblings as `./x.js` (what TypeScript and
 * Vite expect), and Node does not map those to `./x.ts`. This hook retries a
 * missing relative `.js` import as `.ts`. Load it with
 * `node --import ./scripts/ts-resolve.mjs scripts/<name>.ts`.
 */
import { registerHooks } from 'node:module';

registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (error) {
			if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !/^\.\.?\/.*\.js$/.test(specifier)) throw error;
			return nextResolve(specifier.slice(0, -3) + '.ts', context);
		}
	}
});

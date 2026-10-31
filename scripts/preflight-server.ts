import { checkConfig, readEnv } from '../src/lib/server/env.ts';

const error = checkConfig(readEnv(process.env));
if (error !== undefined) {
	console.error(`beads-web configuration rejected: ${error}`);
	process.exit(1);
}

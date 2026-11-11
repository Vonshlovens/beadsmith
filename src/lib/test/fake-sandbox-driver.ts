/**
 * A `SandboxDriver` over one fake sandbox (`sbx1`) whose hc core is a
 * `FakeHcCore`, for tests that reach a sandbox's terminals without E2B. The
 * test sets the sandbox's state (running, paused, gone) and counts connects,
 * since a connect is what resumes a paused sandbox.
 */
import { connectHc } from '../hc/client.js';
import type { SandboxDriver, SandboxInfo, SandboxRef } from '../server/e2b/sandbox.js';
import type { FakeHcCore } from './fake-hc.js';

/** One sandbox (`sbx1`) whose state the test sets, and every connect it saw. */
export function fakeSandboxDriver(core: FakeHcCore) {
	const state: { info: SandboxInfo | undefined; connects: number } = {
		info: { id: 'sbx1', state: 'running', metadata: {} },
		connects: 0
	};
	const sandbox = { id: 'sbx1' } as SandboxRef;
	const driver: SandboxDriver = {
		async create() {
			throw new Error('not in these tests');
		},
		async connect(id) {
			if (state.info === undefined || id !== state.info.id) throw new Error('gone');
			state.connects += 1;
			state.info = { ...state.info, state: 'running' };
			return sandbox;
		},
		async info(id) {
			return state.info?.id === id ? state.info : undefined;
		},
		async find(metadata) {
			const info = state.info;
			if (info === undefined) return [];
			return Object.entries(metadata).every(([key, value]) => info.metadata[key] === value)
				? [info]
				: [];
		}
	};
	return { driver, state, connect_hc: () => connectHc(core.connect()) };
}

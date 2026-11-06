import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { ChatStore } from './event-log.js';
import { AgentSession } from './session.js';
import { localSpawner } from './spawn.js';

const dirs: string[] = [];
function log() {
	const dir = mkdtempSync(join(tmpdir(), 'mate-session-'));
	dirs.push(dir);
	const log = new ChatStore(dir).get('chat');
	log.setMeta({
		session_id: '00000000-0000-4000-8000-000000000000',
		scope: null,
		started: false,
		created_at: ''
	});
	return log;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
class Child extends EventEmitter {
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	kill() {
		return true;
	}
}
it('holds the slot until exit and refuses writes during stop', async () => {
	const child = new Child();
	const record = log();
	const session = new AgentSession(record, () => child);
	session.send('hello');
	const stop = session.stop();
	expect(session.running).toBe(true);
	expect(() => session.send('lost')).toThrow('stopping');
	child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n');
	expect(record.after(undefined)).toHaveLength(0);
	child.emit('exit', 0);
	await stop;
	expect(session.running).toBe(false);
	expect(record.after(undefined).at(-1)).toMatchObject({ type: 'error' });
});
it('handles asynchronous executable-not-found without crashing the runner', async () => {
	const record = log();
	const session = new AgentSession(
		record,
		localSpawner('/nonexistent-mate-test-command', tmpdir())
	);
	const failed = new Promise<void>((resolve) =>
		record.subscribe((event) => {
			if (event.type === 'error') resolve();
		})
	);
	session.send('hello');
	await failed;
	expect(session.running).toBe(false);
	expect(record.after(undefined).at(-1)).toMatchObject({ type: 'error' });
});

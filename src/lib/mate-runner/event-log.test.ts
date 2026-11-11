import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatStore } from './event-log.js';

const dirs: string[] = [];
function directory() {
	const dir = mkdtempSync(join(tmpdir(), 'mate-log-'));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('crash recovery', () => {
	it('repairs a torn tail before appending and preserves message deduplication', () => {
		const dir = directory();
		const log = new ChatStore(dir).get('chat');
		log.appendUser('hello', 'm1');
		appendFileSync(join(dir, 'chat.jsonl'), '{"type":"assistant"');
		const recovered = new ChatStore(dir).get('chat');
		expect(recovered.after(undefined).at(-1)).toMatchObject({ type: 'error' });
		expect(recovered.appendUser('hello', 'm1').created).toBe(false);
		recovered.append({ type: 'result', status: 'succeeded' });
		expect(new ChatStore(dir).get('chat').after(undefined)).toEqual(recovered.after(undefined));
	});
	it('reports unfinished queued work even if the last completed turn has a result', () => {
		const dir = directory();
		const log = new ChatStore(dir).get('chat');
		log.setMeta({ session_id: 'test', scope: null, pending: 1, created_at: '' });
		log.append({ type: 'result', status: 'succeeded' });
		const recovered = new ChatStore(dir).get('chat');
		expect(recovered.after(undefined).at(-1)).toMatchObject({ type: 'error' });
		expect(new ChatStore(dir).get('chat').after(undefined)).toHaveLength(2);
	});
});

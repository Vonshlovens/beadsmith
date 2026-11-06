import { describe, expect, it } from 'vitest';
import type { MateEvent } from '#lib/mate.js';
import {
	GROUP_GAP_MS,
	chatHref,
	chatTitle,
	groupMateEvents,
	initials,
	isWorking,
	mergeEvents,
	placeMateRows
} from './mate-chat';

const AT = '2026-11-05T00:00:00.000Z';

function ev(event: Record<string, unknown>): MateEvent {
	return { at: AT, ...event } as MateEvent;
}

describe('chatTitle', () => {
	it('uses the first line, with whitespace collapsed', () => {
		expect(chatTitle('  what is   ready?\nand more')).toBe('what is ready?');
	});

	it('cuts a long line with an ellipsis', () => {
		const title = chatTitle('x'.repeat(200));
		expect(title).toHaveLength(60);
		expect(title.endsWith('…')).toBe(true);
	});

	it('names an empty message', () => {
		expect(chatTitle('   ')).toBe('New chat');
	});
});

describe('chatHref', () => {
	it('links the chat on the First Mate page', () => {
		expect(chatHref('abc')).toBe('/first-mate?chat=abc');
	});
});

describe('groupMateEvents', () => {
	it('groups a turn into one bubble, with tool calls upserted', () => {
		const bubbles = groupMateEvents([
			ev({ type: 'user', id: 'e1', text: 'tackle it' }),
			ev({ type: 'thinking', id: 'e2', text: 'hmm' }),
			ev({ type: 'assistant', id: 'e3', text: 'On it.' }),
			ev({ type: 'tool_call', id: 'e4', call_id: 'c1', name: 'Bash', status: 'running' }),
			ev({ type: 'tool_call', id: 'e5', call_id: 'c1', name: 'Bash', status: 'completed' }),
			ev({ type: 'assistant', id: 'e6', text: 'Spawned a worker.' }),
			ev({ type: 'assistant', id: 'e7', text: 'It is running.' }),
			ev({ type: 'result', id: 'e8', status: 'succeeded' })
		]);
		expect(bubbles.map((bubble) => bubble.role)).toEqual(['you', 'mate']);
		const mate = bubbles[1]!;
		expect(mate.id).toBe('e2');
		expect(mate.result).toEqual({ status: 'succeeded' });
		expect(mate.parts).toEqual([
			{ kind: 'thinking', id: 'e2', text: 'hmm' },
			{ kind: 'text', id: 'e3', text: 'On it.' },
			{ kind: 'tool', id: 'e4', call_id: 'c1', name: 'Bash', status: 'completed' },
			{ kind: 'text', id: 'e6', text: 'Spawned a worker.\n\nIt is running.' }
		]);
	});

	it('starts a new bubble when the agent speaks unasked after a result', () => {
		const bubbles = groupMateEvents([
			ev({ type: 'user', id: 'e1', text: 'go' }),
			ev({ type: 'assistant', id: 'e2', text: 'Started.' }),
			ev({ type: 'result', id: 'e3', status: 'succeeded' }),
			ev({ type: 'assistant', id: 'e4', text: 'PR ready, captain.' }),
			ev({
				type: 'result',
				id: 'e5',
				status: 'succeeded',
				git_pr_url: 'https://github.com/o/r/pull/3'
			})
		]);
		expect(bubbles.map((bubble) => bubble.id)).toEqual(['e1', 'e2', 'e4']);
		expect(bubbles[2]!.result?.git_pr_url).toBe('https://github.com/o/r/pull/3');
	});

	it('shows a result text only when the turn said nothing else, and keeps errors inline', () => {
		const bubbles = groupMateEvents([
			ev({ type: 'result', id: 'e1', status: 'failed', text: 'Ran out of turns.' }),
			ev({ type: 'error', id: 'e2', message: 'worker crashed' })
		]);
		expect(bubbles).toHaveLength(2);
		expect(bubbles[0]!.parts).toEqual([{ kind: 'text', id: 'e1', text: 'Ran out of turns.' }]);
		expect(bubbles[1]!.parts).toEqual([{ kind: 'error', id: 'e2', message: 'worker crashed' }]);
	});

	it('shows a tool still running when its turn ends as stopped', () => {
		const tool = (id: string, call_id: string, status: 'running' | 'completed') =>
			ev({ type: 'tool_call', id, call_id, name: 'Bash', status });
		const statuses = (events: MateEvent[]) =>
			groupMateEvents(events)
				.flatMap((bubble) => bubble.parts)
				.map((part) => (part.kind === 'tool' ? `${part.call_id}:${part.status}` : part.kind));

		// Stopped turn: the completed call stays completed.
		expect(
			statuses([
				tool('e1', 'a', 'running'),
				tool('e2', 'a', 'completed'),
				tool('e3', 'b', 'running'),
				ev({ type: 'result', id: 'e4', status: 'cancelled' })
			])
		).toEqual(['a:completed', 'b:stopped']);
		// Lost agent: the error ends the turn too.
		expect(
			statuses([tool('e1', 'a', 'running'), ev({ type: 'error', id: 'e2', message: 'gone' })])
		).toEqual(['a:stopped', 'error']);
		// Mid-turn, a running call is still running.
		expect(statuses([tool('e1', 'a', 'running')])).toEqual(['a:running']);
	});
});

describe('isWorking', () => {
	it('is true between a message and the next result', () => {
		expect(isWorking([])).toBe(false);
		const user = ev({ type: 'user', id: 'e1', text: 'go' });
		expect(isWorking([user])).toBe(true);
		expect(isWorking([user, ev({ type: 'result', id: 'e2', status: 'succeeded' })])).toBe(false);
		expect(
			isWorking([
				user,
				ev({ type: 'result', id: 'e2', status: 'succeeded' }),
				ev({ type: 'tool_call', id: 'e3', call_id: 'c', name: 'Bash', status: 'running' })
			])
		).toBe(true);
		expect(isWorking([user, ev({ type: 'error', id: 'e2', message: 'x' })])).toBe(false);
	});
});

describe('mergeEvents', () => {
	it('skips ids already in the log', () => {
		const a = ev({ type: 'user', id: 'e1', text: 'a' });
		const b = ev({ type: 'assistant', id: 'e2', text: 'b' });
		expect(mergeEvents([a], [a, b, b]).map((event) => event.id)).toEqual(['e1', 'e2']);
	});
});

describe('placeMateRows', () => {
	const at = (minutes: number) => new Date(Date.UTC(2026, 10, 6, 12, minutes)).toISOString();
	const now = Date.UTC(2026, 10, 6, 18, 0);

	it('groups one sender’s messages and starts a header when the sender changes', () => {
		const rows = placeMateRows(
			[
				{ role: 'you', at: at(0) },
				{ role: 'mate', at: at(1) },
				{ role: 'mate', at: at(2) },
				{ role: 'you', at: at(3) }
			],
			now
		);
		expect(rows.map((row) => row.head)).toEqual([true, true, false, true]);
		expect(rows[0]!.day).toBe('Today');
		expect(rows.slice(1).every((row) => row.day === undefined)).toBe(true);
	});

	it('starts a new header after a long pause and a divider on a new day', () => {
		const late = new Date(Date.UTC(2026, 10, 6, 12, 0) + GROUP_GAP_MS + 60_000).toISOString();
		const next_day = new Date(Date.UTC(2026, 10, 7, 12, 0)).toISOString();
		const rows = placeMateRows(
			[
				{ role: 'mate', at: at(0) },
				{ role: 'mate', at: late },
				{ role: 'mate', at: next_day }
			],
			Date.UTC(2026, 10, 7, 13, 0)
		);
		expect(rows.map((row) => row.head)).toEqual([true, true, true]);
		expect(rows[0]!.day).toBe('Yesterday');
		expect(rows[2]!.day).toBe('Today');
	});
});

describe('initials', () => {
	it('uses the first two words of the name, else the email', () => {
		expect(initials('Local Tester', 'x@example.com')).toBe('LT');
		expect(initials('  ada  ', undefined)).toBe('A');
		expect(initials('', 'eric@example.com')).toBe('E');
		expect(initials(undefined, undefined)).toBe('?');
	});
});

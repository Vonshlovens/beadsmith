import { describe, expect, it } from 'vitest';
import { MAX_CHATS, chatHref, chatTitle, parseStoredChats, type Chat } from './mate-chat';

function chat(id: string, updated_at: string): Chat {
	return { id, title: id, scope: null, created_at: updated_at, updated_at, messages: [] };
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

describe('parseStoredChats', () => {
	it('returns nothing for missing or broken storage', () => {
		expect(parseStoredChats(null)).toEqual([]);
		expect(parseStoredChats('{')).toEqual([]);
		expect(parseStoredChats('{"a":1}')).toEqual([]);
	});

	it('drops malformed chats and messages', () => {
		const raw = JSON.stringify([
			{
				...chat('a', '2026-10-01T00:00:00Z'),
				messages: [
					{ id: 'm1', role: 'you', text: 'hi', at: '2026-10-01T00:00:00Z' },
					{ id: 'm2', role: 'robot', text: 'no', at: '2026-10-01T00:00:00Z' }
				]
			},
			{ id: 'b' }
		]);
		const chats = parseStoredChats(raw);
		expect(chats.map((item) => item.id)).toEqual(['a']);
		expect(chats[0]?.messages.map((item) => item.id)).toEqual(['m1']);
	});

	it('sorts newest first and keeps the cap', () => {
		const many = Array.from({ length: MAX_CHATS + 5 }, (_, index) =>
			chat(`c${index}`, new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString())
		);
		const chats = parseStoredChats(JSON.stringify(many));
		expect(chats).toHaveLength(MAX_CHATS);
		expect(chats[0]?.id).toBe(`c${MAX_CHATS + 4}`);
	});
});

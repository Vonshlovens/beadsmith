import { describe, expect, it } from 'vitest';
import { parseCapture } from './parse.js';

// Wednesday 2026-10-28, local noon.
const NOW = new Date(2026, 9, 28, 12, 0, 0);
const parse = (input: string) => parseCapture(input, NOW);

describe('parseCapture', () => {
	it('parses the acceptance example', () => {
		const r = parse('ship backups doc tomorrow p1 +beadsmith');
		expect(r).toMatchObject({
			title: 'ship backups doc',
			priority: 1,
			priority_explicit: true,
			due_at: '2026-10-29',
			tags: ['+beadsmith']
		});
		expect(r.tokens.map((t) => t.kind)).toEqual(['due', 'priority', 'tag']);
	});

	it('defaults to P2 with no date or tags', () => {
		expect(parse('water the plants')).toMatchObject({
			title: 'water the plants',
			priority: 2,
			priority_explicit: false,
			due_at: null,
			tags: [],
			tokens: []
		});
	});

	it.each([
		['p0', 0],
		['P4', 4],
		['!3', 3]
	])('reads priority %s', (token, priority) => {
		expect(parse(`task ${token}`)).toMatchObject({ title: 'task', priority });
	});

	it('keeps p5 and a second priority in the title', () => {
		expect(parse('p5 fix p1 p3').title).toBe('p5 fix p3');
		expect(parse('p5 fix p1 p3').priority).toBe(1);
	});

	it.each([
		['today', '2026-10-28'],
		['tomorrow', '2026-10-29'],
		['fri', '2026-10-30'],
		['friday', '2026-10-30'],
		['wednesday', '2026-11-04'],
		['wed', '2026-11-04'],
		['mon', '2026-11-02'],
		['next week', '2026-11-02'],
		['next fri', '2026-10-30'],
		['in 3 days', '2026-10-31'],
		['in 3d', '2026-10-31'],
		['in 1 day', '2026-10-29'],
		['in 2 weeks', '2026-11-11'],
		['in 1w', '2026-11-04'],
		['2026-11-03', '2026-11-03'],
		['due:fri', '2026-10-30'],
		['due:2026-11-03', '2026-11-03'],
		['due:3d', '2026-10-31'],
		['due:tomorrow', '2026-10-29'],
		['by friday', '2026-10-30'],
		['on monday', '2026-11-02']
	])('reads the date "%s"', (phrase, due) => {
		const r = parse(`write docs ${phrase}`);
		expect(r.due_at).toBe(due);
		expect(r.title).toBe('write docs');
	});

	it('crosses month and year ends', () => {
		const dec = parseCapture('x in 5 days', new Date(2026, 11, 29));
		expect(dec.due_at).toBe('2027-01-03');
	});

	it('leaves invalid dates in the title', () => {
		expect(parse('call 2026-02-31 now')).toMatchObject({
			due_at: null,
			title: 'call 2026-02-31 now'
		});
		expect(parse('due:someday sort')).toMatchObject({ due_at: null, title: 'due:someday sort' });
	});

	it('takes only the first date', () => {
		const r = parse('tomorrow review friday');
		expect(r.due_at).toBe('2026-10-29');
		expect(r.title).toBe('review friday');
	});

	it('collects tags, dedupes them, and ignores bare + or @', () => {
		const r = parse('email @phone +acme +ACME + @ lunch');
		expect(r.tags).toEqual(['@phone', '+acme']);
		expect(r.title).toBe('email + @ lunch');
	});

	it('does not read a date lead-in without a date', () => {
		expect(parse('stop by the shop').title).toBe('stop by the shop');
	});

	it('returns an empty title when only tokens are typed', () => {
		expect(parse('p1 tomorrow').title).toBe('');
		expect(parse('   ').tokens).toEqual([]);
	});

	it('uses the local day as today', () => {
		const late = parseCapture('x today', new Date(2026, 9, 28, 23, 59));
		expect(late.due_at).toBe('2026-10-28');
	});
});

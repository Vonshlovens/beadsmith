import { describe, expect, it } from 'vitest';
import { CronError, isTimeZone, latestSlot, nextSlot, parseCron, upcomingSlots } from './cron.js';

const iso = (date: Date | undefined) => date?.toISOString();

describe('parseCron', () => {
	it('parses stars, lists, ranges, steps and names', () => {
		const schedule = parseCron('*/15 2,14 * jan-mar mon-fri');
		expect([...schedule.minutes]).toEqual([0, 15, 30, 45]);
		expect([...schedule.hours]).toEqual([2, 14]);
		expect(schedule.days_of_month.size).toBe(31);
		expect([...schedule.months]).toEqual([1, 2, 3]);
		expect([...schedule.days_of_week]).toEqual([1, 2, 3, 4, 5]);
	});

	it('treats 7 as Sunday and a start with a step as running to the end', () => {
		expect([...parseCron('0 0 * * 7').days_of_week]).toEqual([0]);
		expect([...parseCron('50/5 * * * *').minutes]).toEqual([50, 55]);
	});

	it.each([
		['', 'empty'],
		['* * * *', 'five fields'],
		['60 * * * *', 'outside 0-59'],
		['* * 0 * *', 'outside 1-31'],
		['5-1 * * * *', 'backwards'],
		['*/0 * * * *', 'positive'],
		['a * * * *', 'not a number'],
		['1,,2 * * * *', 'empty list item'],
		['0 0 1 * mon', 'not both']
	])('refuses %j', (expression, message) => {
		expect(() => parseCron(expression)).toThrow(CronError);
		expect(() => parseCron(expression)).toThrow(message);
	});

	it('allows a stepped day of month with an unrestricted weekday', () => {
		expect(() => parseCron('0 0 */2 * *')).not.toThrow();
	});
});

describe('isTimeZone', () => {
	it('knows IANA zones and refuses others', () => {
		expect(isTimeZone('UTC')).toBe(true);
		expect(isTimeZone('America/Toronto')).toBe(true);
		expect(isTimeZone('Mars/Olympus')).toBe(false);
		expect(isTimeZone('')).toBe(false);
	});
});

describe('slots', () => {
	it('finds the latest slot at or before now, inclusive', () => {
		const daily = parseCron('0 2 * * *');
		expect(iso(latestSlot(daily, 'UTC', new Date('2026-11-11T02:00:00Z')))).toBe(
			'2026-11-11T02:00:00.000Z'
		);
		expect(iso(latestSlot(daily, 'UTC', new Date('2026-11-11T01:59:59Z')))).toBe(
			'2026-11-10T02:00:00.000Z'
		);
	});

	it('finds the next slot strictly after a time', () => {
		const every_minute = parseCron('* * * * *');
		expect(iso(nextSlot(every_minute, 'UTC', new Date('2026-11-11T02:00:30Z')))).toBe(
			'2026-11-11T02:01:00.000Z'
		);
		expect(iso(nextSlot(parseCron('30 9 * * mon'), 'UTC', new Date('2026-11-11T00:00Z')))).toBe(
			'2026-11-16T09:30:00.000Z'
		);
	});

	it('evaluates the wall clock of the time zone', () => {
		// 02:00 in Toronto is 07:00 UTC in November (EST, UTC-5).
		expect(
			iso(nextSlot(parseCron('0 2 * * *'), 'America/Toronto', new Date('2026-11-11T00:00Z')))
		).toBe('2026-11-11T07:00:00.000Z');
		// A half-hour zone: 09:00 in Kolkata is 03:30 UTC.
		expect(
			iso(nextSlot(parseCron('0 9 * * *'), 'Asia/Kolkata', new Date('2026-11-11T00:00Z')))
		).toBe('2026-11-11T03:30:00.000Z');
	});

	it('skips a wall-clock time that a daylight-saving jump removes', () => {
		// 2026-03-08 02:30 does not exist in Toronto; the next is 9 March.
		expect(
			iso(nextSlot(parseCron('30 2 * * *'), 'America/Toronto', new Date('2026-03-08T05:00Z')))
		).toBe('2026-03-09T06:30:00.000Z');
	});

	it('fires a repeated wall-clock time at each occurrence', () => {
		// 2026-11-01 01:30 happens twice in Toronto: 05:30 and 06:30 UTC.
		const slots = upcomingSlots(
			parseCron('30 1 * * *'),
			'America/Toronto',
			new Date('2026-11-01T04:00Z'),
			2
		);
		expect(slots.map((slot) => slot.toISOString())).toEqual([
			'2026-11-01T05:30:00.000Z',
			'2026-11-01T06:30:00.000Z'
		]);
	});

	it('finds a leap day years ahead and gives up on an impossible date', () => {
		expect(iso(nextSlot(parseCron('0 0 29 2 *'), 'UTC', new Date('2026-11-11T00:00Z')))).toBe(
			'2028-02-29T00:00:00.000Z'
		);
		expect(nextSlot(parseCron('0 0 30 2 *'), 'UTC', new Date('2026-11-11T00:00Z'))).toBeUndefined();
	});

	it('previews the next few slots', () => {
		const slots = upcomingSlots(parseCron('0 */6 * * *'), 'UTC', new Date('2026-11-11T05:00Z'), 3);
		expect(slots.map((slot) => slot.toISOString())).toEqual([
			'2026-11-11T06:00:00.000Z',
			'2026-11-11T12:00:00.000Z',
			'2026-11-11T18:00:00.000Z'
		]);
	});
});

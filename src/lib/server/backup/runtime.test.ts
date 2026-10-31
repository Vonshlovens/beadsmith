import { describe, expect, it } from 'vitest';
import { isBackupDue } from './runtime.js';

const NOW = new Date('2026-10-17T12:00:00.000Z');

describe('isBackupDue', () => {
	it('runs immediately when nothing has run yet', () => {
		expect(isBackupDue(NOW, 24, undefined, undefined)).toBe(true);
	});

	it('waits for the interval after a success', () => {
		expect(isBackupDue(NOW, 24, '2026-10-16T13:00:00.000Z', '2026-10-16T12:59:00.000Z')).toBe(
			false
		);
		expect(isBackupDue(NOW, 24, '2026-10-16T12:00:00.000Z', '2026-10-16T11:59:00.000Z')).toBe(true);
	});

	it('backs off 15 minutes after any attempt, including failures', () => {
		expect(isBackupDue(NOW, 1, undefined, '2026-10-17T11:50:00.000Z')).toBe(false);
		expect(isBackupDue(NOW, 1, undefined, '2026-10-17T11:44:00.000Z')).toBe(true);
	});
});

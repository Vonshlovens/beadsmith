import { describe, expect, it } from 'vitest';
import { cubicBezier, springOut } from './motion';

describe('springOut', () => {
	it('starts at 0, ends at 1 and overshoots in between', () => {
		expect(springOut(0)).toBe(0);
		expect(springOut(1)).toBe(1);
		const peak = Math.max(...Array.from({ length: 100 }, (_, i) => springOut(i / 100)));
		expect(peak).toBeGreaterThan(1.05);
	});

	it('is the identity for a linear bezier', () => {
		const linear = cubicBezier(0, 0, 1, 1);
		expect(linear(0.3)).toBeCloseTo(0.3, 3);
	});
});

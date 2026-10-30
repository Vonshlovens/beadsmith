import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME } from './product.js';

describe('PRODUCT_NAME', () => {
	it('is the visible Beadsmith brand, not a legacy product name', () => {
		expect(PRODUCT_NAME).toBe('Beadsmith');
		expect(PRODUCT_NAME.toLowerCase()).not.toContain('bdui');
		expect(PRODUCT_NAME.toLowerCase()).not.toContain('beads-web');
	});
});

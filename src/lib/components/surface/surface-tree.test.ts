/**
 * Render tests for the catalog surface renderer (ADR-0025 rule 2). They
 * render the real components with `svelte/server`, so the guarantees the
 * ADR leans on are checked where they hold, not only in the helpers:
 * model-written text is escaped, and a binding that did not resolve shows
 * its reason in place of its component, never an empty list or a zero.
 */
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { SurfaceBindingResult, SurfaceSpecShape } from '#lib/surfaces.js';
import { surface_spec_schema } from '#lib/server/grown/surface-spec.js';
import SurfaceTree from './surface-tree.svelte';

const HOSTILE = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

/** Parsed through the real schema, so defaults (a heading's level) apply. */
function spec(): SurfaceSpecShape {
	return surface_spec_schema.parse({
		root: 'main',
		components: [
			{ id: 'main', component: 'Stack', children: ['title', 'note', 'stats'] },
			{ id: 'title', component: 'Heading', text: HOSTILE },
			{ id: 'note', component: 'Text', text: HOSTILE },
			{ id: 'stats', component: 'Row', children: ['ready_count', 'blocked_count'] },
			{ id: 'ready_count', component: 'StatTile', label: HOSTILE, count: 'ready' },
			{ id: 'blocked_count', component: 'StatTile', label: 'Blocked', count: 'blocked' }
		],
		data: {
			ready: { tool: 'ready_work', input: { limit: 20 } },
			blocked: { view: 'blocked-on-review' }
		}
	}) as SurfaceSpecShape;
}

function draw(bindings: Record<string, SurfaceBindingResult> | null): string {
	return render(SurfaceTree, {
		props: { spec: spec(), bindings, name: 'Review', slug: 'review', revision: 1, can_act: false }
	}).body;
}

const FAILED: SurfaceBindingResult = {
	ok: false,
	code: 'forbidden',
	message: 'This read needs an admin.'
};

describe('surface renderer', () => {
	it('escapes model-written text in headings, text and labels', () => {
		const html = draw({ ready: FAILED, blocked: FAILED });
		// Svelte escapes `<` (and `&`) in text, which is enough to keep the
		// markup inert: no element is ever created from model text.
		expect(html).not.toContain('<img src=x');
		expect(html).not.toContain('<script>alert(2)');
		expect(html).toContain('&lt;img src=x');
		expect(html).toContain('&lt;script>alert(2)&lt;/script>');
		expect(html).not.toContain('undefined');
	});

	it('shows a failed binding with its reason, never a zero', () => {
		const html = draw({ ready: FAILED, blocked: FAILED });
		expect(html).toContain('Blocked could not be read.');
		expect(html).toContain('This read needs an admin.');
		expect(html).not.toMatch(/sf-stat-n[^>]*>\s*0/);
	});

	it('still draws headings and text when the whole read failed', () => {
		const html = draw(null);
		expect(html).toContain('&lt;script>alert(2)');
		expect(html).toContain('could not be read.');
	});
});

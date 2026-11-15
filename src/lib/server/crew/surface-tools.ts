/**
 * Crew surface tools (ADR-0025 rules 2, 5, 7, 8 and 9): First Mate builds
 * catalog surfaces (dashboards over Beadsmith's own components) by
 * conversation, through the same grown things store the `/api/surfaces`
 * routes use, with the rules every grown tool shares (`grown-tools.ts`).
 *
 * - `define_surface` takes the spec as plain JSON and leaves every check to
 *   the store's parse (catalog, tree, limits, bridge allowlist, each tool
 *   input against its crew tool's schema), so a bad tree comes back with the
 *   same message the browser API gives, and there is one validator.
 * - The catalog the model reads in the tool description is generated from
 *   the catalog schema itself (`surfaceCatalogGuide`), so adding a component
 *   or prop teaches it without a second copy to keep in step.
 * - There is no publish or share tool (rule 7): a surface First Mate writes
 *   is owner-private until an admin publishes it from the browser.
 */
import { z } from 'zod';
import {
	GROWN_DESCRIPTION_MAX,
	GROWN_NAME_MAX,
	type GrownThing,
	type GrownViewer
} from '../grown/store.js';
import {
	SURFACE_MAX_ACTIONS,
	SURFACE_MAX_BINDINGS,
	SURFACE_MAX_DEPTH,
	SURFACE_MAX_NODES,
	SURFACE_SPEC_MAX_BYTES,
	surface_component_schema
} from '../grown/surface-spec.js';
import {
	BRIDGE_ACTION_NAMES,
	BRIDGE_ACTIONS,
	BRIDGE_READ_NAMES,
	BRIDGE_READS
} from '../grown/bridge.js';
import type { SurfaceSpecShape } from '#lib/surfaces.js';
import { defineTool, type CrewTool } from './registry.js';
import {
	defineGrown,
	GROWN_WRITE_PERMISSION,
	grown,
	grownHistoryTool,
	grownRevertTool,
	grownSlugSchema,
	grownStore,
	compactGrown,
	viewerOf
} from './grown-tools.js';

/** One JSON Schema property as a short type: `sm|md|lg`, `text`, `[ids]`. */
function propType(schema: Record<string, unknown>): string {
	if (Array.isArray(schema.enum)) return schema.enum.join('|');
	if ('const' in schema) return String(schema.const);
	if (Array.isArray(schema.anyOf)) {
		return (schema.anyOf as Record<string, unknown>[]).map(propType).join('|');
	}
	switch (schema.type) {
		case 'array':
			return '[ids]';
		case 'integer':
		case 'number':
			return 'number';
		case 'boolean':
			return 'true|false';
		default:
			return 'text';
	}
}

/**
 * One line per catalog component, from its own strict schema: its props,
 * `?` for optional ones and `=` for their defaults. `id` and `component` are
 * on every entry and left out.
 */
export function surfaceCatalogGuide(): string {
	return surface_component_schema.options
		.map((entry) => {
			const json = z.toJSONSchema(entry, { io: 'input' }) as {
				properties: Record<string, Record<string, unknown>>;
				required?: string[];
			};
			const required = new Set(json.required ?? []);
			const props = Object.entries(json.properties)
				.filter(([key]) => key !== 'id' && key !== 'component')
				.map(([key, prop]) => {
					const fallback = 'default' in prop ? ` = ${JSON.stringify(prop.default)}` : '';
					return `${key}${required.has(key) ? '' : '?'}: ${propType(prop)}${fallback}`;
				});
			return `- ${entry.shape.component.value} { ${props.join(', ')} }`;
		})
		.join('\n');
}

const NEEDS_PROJECT = [
	...BRIDGE_READ_NAMES.filter((name) => BRIDGE_READS[name].needs_project),
	...BRIDGE_ACTION_NAMES.filter((name) => BRIDGE_ACTIONS[name].needs_project)
];

const EXAMPLE = {
	root: 'main',
	components: [
		{ id: 'main', component: 'Stack', children: ['title', 'stats', 'ready_list'] },
		{ id: 'title', component: 'Heading', text: 'Ready work' },
		{ id: 'stats', component: 'Row', children: ['ready_count'] },
		{ id: 'ready_count', component: 'StatTile', label: 'Ready', count: 'ready' },
		{ id: 'ready_list', component: 'IssueList', data: 'ready', limit: 10 }
	],
	data: { ready: { tool: 'ready_work', input: { limit: 50 } } }
};

const DEFINE_DESCRIPTION = [
	'Create a catalog surface (a dashboard built from Beadsmith components), or revise one of',
	'yours under the same slug. Send the whole spec each time; an omitted description carries',
	'over. Every change is a new revision the owner can revert. Surfaces you write are private',
	'to the chat owner until an admin publishes them in the browser. Returns the surface and',
	'its URL; give the captain the link.',
	'',
	'A spec is a flat list of components under one root: each has a unique `id` and a',
	'`component`; Stack and Row name their children by id. Every component is reachable from',
	'`root`, has one parent, and takes only the props listed:',
	surfaceCatalogGuide(),
	'',
	'`data` names the bindings that StatTile `count`, IssueList, IssueBoard and Chart `data`',
	'read: `{ "view": "<saved view slug>" }` or `{ "tool": "<read>", "input": { … } }` with',
	`read one of ${BRIDGE_READ_NAMES.join(', ')}; the input is that crew tool's own input.`,
	'IssueList, IssueBoard and Chart need issues (a view, ready_work or list_issues). Bindings',
	'run as whoever opens the surface, so a member sees what a member may read.',
	'`actions` names what a Button `action` does: `{ "tool": "<action>", "input": { … } }` with',
	`action one of ${BRIDGE_ACTION_NAMES.join(', ')}; the viewer confirms before it runs.`,
	`${NEEDS_PROJECT.join(', ')} must name \`project\` (a surface has no chat project).`,
	'Every binding and action is used by some component.',
	`Limits: ${SURFACE_MAX_NODES} components, depth ${SURFACE_MAX_DEPTH},`,
	`${SURFACE_MAX_BINDINGS} bindings, ${SURFACE_MAX_ACTIONS} actions,`,
	`${SURFACE_SPEC_MAX_BYTES / 1024} KB. Text is shown as text; Markdown is sanitized.`,
	`Example: ${JSON.stringify(EXAMPLE)}`
].join('\n');

/** A surface's summary without its tree, which can run to 32 KB each. */
function listedSurface(thing: GrownThing, viewer: GrownViewer) {
	const { spec, ...summary } = compactGrown<SurfaceSpecShape>(thing, viewer);
	return {
		...summary,
		components: spec.components.length,
		data: Object.keys(spec.data),
		actions: Object.keys(spec.actions)
	};
}

export const define_surface = defineTool({
	name: 'define_surface',
	description: DEFINE_DESCRIPTION,
	input: z.strictObject({
		slug: grownSlugSchema('surface'),
		name: z.string().min(1).max(GROWN_NAME_MAX),
		description: z.string().max(GROWN_DESCRIPTION_MAX).optional(),
		spec: z
			.record(z.string(), z.unknown())
			.describe('{ root, components, data?, actions? } as the tool description sets out.')
	}),
	permission: GROWN_WRITE_PERMISSION,
	async handler(ctx, input, deps) {
		const { written, thing, viewer } = await defineGrown(ctx, deps, 'surface', input);
		return { written, surface: compactGrown<SurfaceSpecShape>(thing, viewer) };
	}
});

export const list_surfaces = defineTool({
	name: 'list_surfaces',
	description:
		'List catalog surfaces: the chat owner’s own (latest revision) and the ones members can ' +
		'see (published revision), newest change first, with their URLs, component counts and ' +
		'binding and action names. For a surface’s current spec, use surface_history with limit 1.',
	input: z.strictObject({}),
	async handler(ctx, _input, deps) {
		const viewer = viewerOf(ctx);
		const things = await grown(async () => (await grownStore(deps)).list(viewer, 'surface'));
		return { surfaces: things.map((thing) => listedSurface(thing, viewer)) };
	}
});

export const surface_history = grownHistoryTool(
	'surface',
	'surface_history',
	'The kept revisions of one of the chat owner’s surfaces, newest first: number, who wrote ' +
		'it, its spec and whether members see it. Use a number with revert_surface; the newest ' +
		'is the spec to edit when revising.'
);

export const revert_surface = grownRevertTool(
	'surface',
	'revert_surface',
	'Restore one of the chat owner’s surfaces to an earlier revision (from surface_history). ' +
		'The revert is itself a new revision, so nothing is lost. What members see changes only ' +
		'when an admin publishes.'
);

export const SURFACE_TOOLS: CrewTool[] = [
	define_surface,
	list_surfaces,
	surface_history,
	revert_surface
];

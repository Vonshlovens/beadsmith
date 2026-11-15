/**
 * Catalog surfaces (ADR-0025 rule 2): a JSON component tree over Beadsmith's
 * own component catalog, stored as data and rendered natively by Svelte.
 *
 * The shape follows A2UI's flat component list (each component has an id and
 * names its children by id, under one `root`), so a tree streams and patches
 * by id and stays close to the protocol; it is Beadsmith's own schema, not an
 * A2UI or json-render dependency (see ADR-0025's implementation notes).
 *
 * Everything is refused when saved, never skipped when rendered:
 * - a component the catalog does not define, or a prop it does not take
 *   (every component is a strict object);
 * - a tree that is not one: duplicate ids, a missing root or child, a
 *   component with two parents, a cycle, or a component the root never
 *   reaches;
 * - more than the limits allow (200 nodes, depth 8, 12 bindings, 32 KB);
 * - a binding or action that names a tool not on the bridge allowlist
 *   (`bridge.ts`), or whose data a component cannot show;
 * - a tool input the crew tool's own schema refuses (`surfaceToolProblems`,
 *   which the store runs after the schema).
 *
 * Text is text: no prop is ever read as markup or code. `Markdown` goes
 * through the app's sanitizing renderer.
 */
import { z } from 'zod';
import {
	BRIDGE_READ_NAMES,
	BRIDGE_READS,
	bridgeInputProblems,
	type BridgeYield
} from './bridge.js';
import { BRIDGE_ACTION_NAMES, GROWN_SLUG_MAX, GROWN_SLUG_PATTERN } from '#lib/grown.js';

/** Most JSON bytes in a surface spec (ADR-0025 limits). */
export const SURFACE_SPEC_MAX_BYTES = 32 * 1024;
export const SURFACE_MAX_NODES = 200;
/** The root is depth 1. */
export const SURFACE_MAX_DEPTH = 8;
export const SURFACE_MAX_BINDINGS = 12;
export const SURFACE_MAX_ACTIONS = 12;

/** A component id, binding or action name: a short lowercase word. */
const name_schema = z
	.string()
	.regex(/^[a-z][a-z0-9_-]{0,47}$/, 'a name is a lowercase word like "blocked_list"');

const children_schema = z.array(name_schema).max(SURFACE_MAX_NODES).default([]);
const gap_schema = z.enum(['sm', 'md', 'lg']).default('md');
const plain = (max: number) =>
	z
		.string()
		.min(1)
		.max(max)
		.regex(/^[^\p{Cc}]*$/u, 'plain text, no control characters');

/** Columns a chart can count issues by. */
export const SURFACE_CHART_BY = ['status', 'priority', 'type', 'assignee', 'project'] as const;

/**
 * The catalog. Each entry is a strict object keyed by `component`; adding a
 * component is a repository change with its Svelte renderer.
 */
const catalog = [
	z.strictObject({
		id: name_schema,
		component: z.literal('Stack'),
		gap: gap_schema,
		children: children_schema
	}),
	z.strictObject({
		id: name_schema,
		component: z.literal('Row'),
		gap: gap_schema,
		wrap: z.boolean().default(true),
		children: children_schema
	}),
	z.strictObject({
		id: name_schema,
		component: z.literal('Heading'),
		text: plain(200),
		level: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(2)
	}),
	z.strictObject({ id: name_schema, component: z.literal('Text'), text: plain(2_000) }),
	z.strictObject({
		id: name_schema,
		component: z.literal('Markdown'),
		// Markdown keeps its newlines and tabs; the renderer sanitizes it.
		text: z.string().min(1).max(8_000)
	}),
	z.strictObject({
		id: name_schema,
		component: z.literal('StatTile'),
		label: plain(80),
		/** The number of rows a list binding returns. */
		count: name_schema,
		hint: plain(160).optional()
	}),
	z.strictObject({
		id: name_schema,
		component: z.literal('IssueList'),
		data: name_schema,
		limit: z.number().int().min(1).max(100).default(25),
		empty: plain(200).optional()
	}),
	z.strictObject({
		id: name_schema,
		component: z.literal('IssueBoard'),
		data: name_schema
	}),
	z.strictObject({
		id: name_schema,
		component: z.literal('Chart'),
		data: name_schema,
		chart: z.literal('bar').default('bar'),
		by: z.enum(SURFACE_CHART_BY),
		title: plain(120).optional()
	}),
	z.strictObject({
		id: name_schema,
		component: z.literal('Button'),
		label: plain(60),
		action: name_schema,
		tone: z.enum(['default', 'primary', 'danger']).default('default')
	})
] as const;

export const surface_component_schema = z.discriminatedUnion('component', catalog);
export type SurfaceComponent = z.infer<typeof surface_component_schema>;
export type SurfaceComponentName = SurfaceComponent['component'];
export const SURFACE_COMPONENTS = catalog.map(
	(entry) => entry.shape.component.value
) as SurfaceComponentName[];

const tool_input_schema = z.record(z.string(), z.unknown()).default({});

/** Data a surface reads: a saved view, or a bridge read tool with its input. */
const binding_schema = z.union([
	z.strictObject({
		view: z
			.string()
			.max(GROWN_SLUG_MAX)
			.regex(GROWN_SLUG_PATTERN, 'a view slug, like "blocked-on-review"')
	}),
	z.strictObject({ tool: z.enum(BRIDGE_READ_NAMES), input: tool_input_schema })
]);

/** What a button does: a bridge action tool with its input, run after a host confirm. */
const action_schema = z.strictObject({
	tool: z.enum(BRIDGE_ACTION_NAMES),
	input: tool_input_schema
});

export type SurfaceBinding = z.infer<typeof binding_schema>;
export type SurfaceAction = z.infer<typeof action_schema>;

/** The data each binding-reading prop needs. */
const NEEDS: Partial<Record<SurfaceComponentName, readonly BridgeYield[]>> = {
	IssueList: ['issues'],
	IssueBoard: ['issues'],
	Chart: ['issues'],
	StatTile: ['issues', 'projects', 'missions', 'todos']
};

function yieldOf(binding: SurfaceBinding): BridgeYield {
	return 'view' in binding ? 'issues' : BRIDGE_READS[binding.tool].yields;
}

type Ctx = z.RefinementCtx;

function problem(ctx: Ctx, path: (string | number)[], message: string): void {
	ctx.addIssue({ code: 'custom', path, message });
}

/** The tree checks: references resolve, one parent each, reachable, no cycle, within depth. */
function checkTree(
	spec: {
		root: string;
		components: SurfaceComponent[];
		data: Record<string, SurfaceBinding>;
		actions: Record<string, SurfaceAction>;
	},
	ctx: Ctx
): void {
	const byId = new Map<string, SurfaceComponent>();
	spec.components.forEach((component, index) => {
		if (byId.has(component.id)) {
			problem(ctx, ['components', index, 'id'], `the id "${component.id}" is used twice`);
		}
		byId.set(component.id, component);
	});
	if (!byId.has(spec.root)) {
		problem(ctx, ['root'], `no component has the root id "${spec.root}"`);
		return;
	}

	const parent = new Map<string, string>();
	spec.components.forEach((component, index) => {
		if (!('children' in component)) return;
		component.children.forEach((child, at) => {
			const path = ['components', index, 'children', at];
			if (!byId.has(child)) return problem(ctx, path, `no component has the id "${child}"`);
			if (child === spec.root) return problem(ctx, path, 'the root cannot be a child');
			const other = parent.get(child);
			if (other !== undefined) {
				return problem(ctx, path, `"${child}" is already a child of "${other}"`);
			}
			parent.set(child, component.id);
		});
	});

	// Walk from the root. With one parent each and the root parentless, the
	// walk visits each component once; anything it misses is unreachable
	// (an orphan, or part of a cycle that never meets the root).
	const reached = new Set<string>();
	let deepest = 0;
	const stack: [string, number][] = [[spec.root, 1]];
	while (stack.length > 0) {
		const [id, depth] = stack.pop()!;
		if (reached.has(id)) continue;
		reached.add(id);
		deepest = Math.max(deepest, depth);
		const component = byId.get(id)!;
		if ('children' in component) {
			for (const child of component.children) {
				if (byId.has(child) && parent.get(child) === id) stack.push([child, depth + 1]);
			}
		}
	}
	if (deepest > SURFACE_MAX_DEPTH) {
		problem(ctx, ['components'], `the tree is ${deepest} deep; at most ${SURFACE_MAX_DEPTH}`);
	}
	spec.components.forEach((component, index) => {
		if (!reached.has(component.id)) {
			problem(ctx, ['components', index], `"${component.id}" is not reachable from the root`);
		}
	});

	const used_data = new Set<string>();
	const used_actions = new Set<string>();
	spec.components.forEach((component, index) => {
		const name =
			'data' in component ? component.data : 'count' in component ? component.count : undefined;
		if (name !== undefined) {
			const key = 'data' in component ? 'data' : 'count';
			const binding = spec.data[name];
			if (binding === undefined) {
				problem(ctx, ['components', index, key], `there is no data binding "${name}"`);
			} else {
				used_data.add(name);
				const needs = NEEDS[component.component] ?? [];
				const has = yieldOf(binding);
				if (!needs.includes(has)) {
					problem(
						ctx,
						['components', index, key],
						`${component.component} shows ${needs.join(' or ')}, but "${name}" reads ${has}`
					);
				}
			}
		}
		if (component.component === 'Button') {
			if (spec.actions[component.action] === undefined) {
				problem(ctx, ['components', index, 'action'], `there is no action "${component.action}"`);
			} else {
				used_actions.add(component.action);
			}
		}
	});

	for (const name of Object.keys(spec.data)) {
		if (!used_data.has(name)) problem(ctx, ['data', name], `no component reads "${name}"`);
	}
	for (const name of Object.keys(spec.actions)) {
		if (!used_actions.has(name)) problem(ctx, ['actions', name], `no button uses "${name}"`);
	}
}

export const surface_spec_schema = z
	.strictObject({
		root: name_schema,
		components: z.array(surface_component_schema).min(1).max(SURFACE_MAX_NODES),
		data: z
			.record(name_schema, binding_schema)
			.default({})
			.refine(
				(data) => Object.keys(data).length <= SURFACE_MAX_BINDINGS,
				`at most ${SURFACE_MAX_BINDINGS} data bindings`
			),
		actions: z
			.record(name_schema, action_schema)
			.default({})
			.refine(
				(actions) => Object.keys(actions).length <= SURFACE_MAX_ACTIONS,
				`at most ${SURFACE_MAX_ACTIONS} actions`
			)
	})
	.superRefine(checkTree);

export type SurfaceSpec = z.infer<typeof surface_spec_schema>;

/**
 * The checks the schema cannot make synchronously: each binding's and
 * action's input against its crew tool's own schema. The store runs this
 * after the schema, on every write, so a bad input is refused when saved.
 * @param spec A spec the schema accepted.
 */
export async function surfaceToolProblems(spec: SurfaceSpec): Promise<string[]> {
	const found: string[] = [];
	for (const [name, binding] of Object.entries(spec.data)) {
		if (!('tool' in binding)) continue;
		for (const message of await bridgeInputProblems(binding.tool, binding.input)) {
			found.push(`data.${name}.input: ${message}`);
		}
	}
	for (const [name, action] of Object.entries(spec.actions)) {
		for (const message of await bridgeInputProblems(action.tool, action.input)) {
			found.push(`actions.${name}.input: ${message}`);
		}
	}
	return found;
}

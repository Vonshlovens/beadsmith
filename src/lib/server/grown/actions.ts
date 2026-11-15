/**
 * Running a grown thing's action for the person who confirmed it (ADR-0025
 * rules 5 and 6): a catalog surface's button, which names a stored action, or
 * a sandboxed app's `tools/call` for an action, which brings its arguments.
 * Either way the action is a bridge action tool (todo changes, or a mission
 * launch through dispatch) and `runBridgeAction` calls that crew tool's own
 * handler **as the viewer**, never as the author, after the same `roleCan`
 * check `mcp.ts` makes, so a member is refused and nothing here adds a rule of
 * its own: a launch still goes through `enqueueDispatch`'s arm, per-project
 * allow and repository map.
 *
 * The browser shows the host confirmation (`confirm-dialog`, outside the
 * surface tree or the app's frame) before it calls this; the request then
 * names the revision the person saw, and a thing revised since is refused
 * rather than run, so what was confirmed is what runs. For an app, the
 * confirmation is drawn from the arguments the request then carries, which
 * are what runs. The confirmation's own key makes a retried request replay
 * the first mission instead of starting another.
 *
 * A launch records the grown thing on its mission (`grown_slug`) instead of a
 * chat, through `bridgeContext`.
 */
import { z } from 'zod';
import { BRIDGE_ACTION_NAMES, type BridgeActionName } from '#lib/grown.js';
import { roleCan } from '../auth/roles.js';
import { CrewToolError, type CrewDeps, type CrewTool } from '../crew/registry.js';
import { BRIDGE_ACTIONS, bridgeTool } from './bridge.js';
import { bridgeContext, type BridgeKind, type BridgeViewer } from './bindings.js';
import { GrownError } from './errors.js';
import type { GrownStore, GrownThing } from './store.js';
import { surface_spec_schema, type SurfaceAction } from './surface-spec.js';

/** One per confirmation, so a retried request replays rather than repeats. */
const confirmation_key_schema = z
	.string()
	.regex(/^[A-Za-z0-9_-]{8,64}$/, 'a confirmation key of 8 to 64 letters or digits');

/** The body of `POST /api/surfaces/:slug/actions/:name`. */
export const surface_action_request_schema = z.strictObject({
	/** The revision whose button the person confirmed. */
	revision: z.number().int().min(1),
	key: confirmation_key_schema
});

export type SurfaceActionRequest = z.infer<typeof surface_action_request_schema>;

/**
 * The body of `POST /api/apps/:slug/actions`: the action and arguments the
 * app asked for, which the host confirmation showed, with the revision on
 * screen and the confirmation's key.
 */
export const app_action_request_schema = z.strictObject({
	name: z.enum(BRIDGE_ACTION_NAMES),
	arguments: z.record(z.string(), z.unknown()).default({}),
	revision: z.number().int().min(1),
	key: confirmation_key_schema
});

export type AppActionRequest = z.infer<typeof app_action_request_schema>;

export interface ActionDeps {
	/** Crew tool modules (dispatch, todos, read plane); production defaults when omitted. */
	crew?: CrewDeps;
	/** The crew tool behind a bridge action; tests may substitute one. */
	tool?: (name: BridgeActionName) => Promise<CrewTool>;
}

/**
 * The stored action a button names, from the revision this viewer sees.
 * @param surface The surface as the store returned it for this viewer.
 * @param name The action's name in the spec.
 */
export function surfaceAction(surface: GrownThing, name: string): SurfaceAction {
	// The store validated the spec on write; parsing again types it and
	// refuses a stored spec today's schema no longer accepts.
	const { actions } = surface_spec_schema.parse(surface.revision.spec);
	if (!Object.hasOwn(actions, name)) {
		throw new GrownError('not_found', `The surface has no action "${name}".`);
	}
	return actions[name];
}

/**
 * Refuse a thing revised since the person confirmed its action, so what was
 * confirmed is what runs.
 * @param thing The thing as the store returned it for this viewer.
 * @param kind Which kind it is, for the message.
 * @param revision The revision the person confirmed.
 */
function confirmedRevision(thing: GrownThing, kind: BridgeKind, revision: number): void {
	if (revision !== thing.revision.number) {
		throw new GrownError(
			'conflict',
			`This ${kind} changed since you opened it. Reload it and check the action again.`
		);
	}
}

/**
 * Run one bridge action as the viewer, for a surface's button or an app's
 * call. The caller has read the thing from the store as this viewer, so a
 * member gets only a published thing, at its published revision.
 * @param store The grown things store, for crew tools that read it.
 * @param viewer The signed-in viewer.
 * @param thing The surface or app as the store returned it for this viewer.
 * @param kind Which kind it is, for messages and the crew context.
 * @param tool_name The bridge action.
 * @param input Its input: a surface's stored one, or an app's confirmed arguments.
 * @param call_id Names the crew call with the key, so a retry replays.
 * @param deps Injectable crew and tool dependencies.
 */
async function runBridgeAction(
	store: GrownStore,
	viewer: BridgeViewer,
	thing: GrownThing,
	kind: BridgeKind,
	tool_name: BridgeActionName,
	input: Record<string, unknown>,
	call_id: string,
	deps: ActionDeps
): Promise<unknown> {
	const tool = await (deps.tool ?? bridgeTool)(tool_name);
	// The check `mcp.ts` makes for a chat, with the viewer's role: an admin's
	// surface or app does not lend a member its permissions.
	if (tool.permission !== undefined && !roleCan(viewer.role, tool.permission)) {
		throw new GrownError(
			'forbidden',
			`${tool.name} needs an admin account; this ${kind} acts as you.`
		);
	}
	// A surface's input was checked when it was saved; an app's arrives with
	// the call, so the project rule is checked here for both.
	if (BRIDGE_ACTIONS[tool_name].needs_project && input.project === undefined) {
		throw new GrownError(
			'bad_request',
			`${tool.name} needs a project: ${kind === 'app' ? 'an app' : 'a surface'} has no chat project to default to.`
		);
	}
	// Parsed again for its defaults, and so a stored input today's schema
	// refuses is refused, not run.
	const parsed = tool.input.safeParse(input);
	if (!parsed.success) {
		const detail = parsed.error.issues
			.slice(0, 3)
			.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
			.join('; ');
		throw new GrownError(
			'bad_request',
			kind === 'surface'
				? `The input for ${tool.name} is no longer valid. Edit the surface.`
				: `The arguments for ${tool.name} are not valid: ${detail}.`
		);
	}
	const crew: CrewDeps = { ...deps.crew, grown: async () => store };
	try {
		return await tool.handler(bridgeContext(viewer, thing.slug, kind), parsed.data, crew, {
			id: call_id
		});
	} catch (error) {
		// A crew refusal (no such issue, the launch limit) is written to be
		// read and is safe; anything else is reduced by `safeError` upstream.
		if (error instanceof CrewToolError) throw new GrownError('bad_request', error.message);
		throw error;
	}
}

/**
 * Run one of a surface's actions as the viewer.
 * @param store The grown things store, for crew tools that read it.
 * @param viewer The signed-in viewer.
 * @param surface The surface as the store returned it for this viewer.
 * @param name The action's name in the spec.
 * @param request The revision the person confirmed and the confirmation's key.
 * @param deps Injectable crew and tool dependencies.
 * @returns The crew tool's result: the todo, or the launched mission.
 */
export async function runSurfaceAction(
	store: GrownStore,
	viewer: BridgeViewer,
	surface: GrownThing,
	name: string,
	request: SurfaceActionRequest,
	deps: ActionDeps = {}
): Promise<unknown> {
	confirmedRevision(surface, 'surface', request.revision);
	const action = surfaceAction(surface, name);
	return runBridgeAction(
		store,
		viewer,
		surface,
		'surface',
		action.tool,
		action.input,
		`surface:${surface.slug}:r${surface.revision.number}:${name}:${request.key}`,
		deps
	);
}

/**
 * Run an action a sandboxed app asked for, with the arguments the host
 * confirmation showed, as the viewer.
 * @param store The grown things store, for crew tools that read it.
 * @param viewer The signed-in viewer.
 * @param app The app as the store returned it for this viewer.
 * @param request The action, its arguments, the revision on screen and the key.
 * @param deps Injectable crew and tool dependencies.
 * @returns The crew tool's result: the todo, or the launched mission.
 */
export async function runAppAction(
	store: GrownStore,
	viewer: BridgeViewer,
	app: GrownThing,
	request: AppActionRequest,
	deps: ActionDeps = {}
): Promise<unknown> {
	confirmedRevision(app, 'app', request.revision);
	return runBridgeAction(
		store,
		viewer,
		app,
		'app',
		request.name,
		request.arguments,
		`app:${app.slug}:r${app.revision.number}:${request.name}:${request.key}`,
		deps
	);
}

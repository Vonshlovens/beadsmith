/**
 * Running a catalog surface's button for the person who pressed it
 * (ADR-0025 rules 5 and 6). A button names one of the surface's actions; an
 * action names a bridge action tool (todo changes, or a mission launch
 * through dispatch) with a stored input. Running it calls that crew tool's
 * own handler **as the viewer**, never as the surface's author, after the
 * same `roleCan` check `mcp.ts` makes, so a member pressing an admin's button
 * is refused and nothing here adds a rule of its own: a launch still goes
 * through `enqueueDispatch`'s arm, per-project allow and repository map.
 *
 * The browser shows the host confirmation (`confirm-dialog`, outside the
 * surface tree) before it calls this; the request then names the revision
 * the person saw, and a surface revised since is refused rather than run, so
 * what was confirmed is what runs. The confirmation's own key makes a
 * retried request replay the first mission instead of starting another.
 *
 * A launch records the surface on its mission (`grown_slug`) instead of a
 * chat, through `bridgeContext`.
 */
import { z } from 'zod';
import { roleCan } from '../auth/roles.js';
import { CrewToolError, type CrewDeps, type CrewTool } from '../crew/registry.js';
import { bridgeTool, type BridgeActionName } from './bridge.js';
import { bridgeContext, type BridgeViewer } from './bindings.js';
import { GrownError } from './errors.js';
import type { GrownStore, GrownThing } from './store.js';
import { surface_spec_schema, type SurfaceAction } from './surface-spec.js';

/** The body of `POST /api/surfaces/:slug/actions/:name`. */
export const surface_action_request_schema = z.strictObject({
	/** The revision whose button the person confirmed. */
	revision: z.number().int().min(1),
	/** One per confirmation, so a retried request replays rather than repeats. */
	key: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'a confirmation key of 8 to 64 letters or digits')
});

export type SurfaceActionRequest = z.infer<typeof surface_action_request_schema>;

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
 * Run one of a surface's actions as the viewer. The caller has read the
 * surface from the store as this viewer, so a member gets only a published
 * surface, at its published revision.
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
	if (request.revision !== surface.revision.number) {
		throw new GrownError(
			'conflict',
			'This surface changed since you opened it. Reload it and check the action again.'
		);
	}
	const action = surfaceAction(surface, name);
	const tool = await (deps.tool ?? bridgeTool)(action.tool);
	// The check `mcp.ts` makes for a chat, with the viewer's role: an admin's
	// surface does not lend a member its permissions.
	if (tool.permission !== undefined && !roleCan(viewer.role, tool.permission)) {
		throw new GrownError(
			'forbidden',
			`${tool.name} needs an admin account; this surface acts as you.`
		);
	}
	// Checked against this schema when saved; parsed again for its defaults,
	// and so a stored input today's schema refuses is refused, not run.
	const input = tool.input.safeParse(action.input);
	if (!input.success) {
		throw new GrownError(
			'bad_request',
			`The input for ${tool.name} is no longer valid. Edit the surface.`
		);
	}
	const crew: CrewDeps = { ...deps.crew, grown: async () => store };
	try {
		return await tool.handler(bridgeContext(viewer, surface.slug), input.data, crew, {
			id: `surface:${surface.slug}:r${surface.revision.number}:${name}:${request.key}`
		});
	} catch (error) {
		// A crew refusal (no such issue, the launch limit) is written to be
		// read and is safe; anything else is reduced by `safeError` upstream.
		if (error instanceof CrewToolError) throw new GrownError('bad_request', error.message);
		throw error;
	}
}

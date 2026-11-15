/**
 * Resolving a catalog surface's data bindings for the person looking at it
 * (ADR-0025 rules 5 and 6). A binding names a saved view or a bridge read
 * tool; resolving it runs that view or tool **as the viewer**, never as the
 * surface's author, so an admin's published surface opened by a member reads
 * what a member may read and a `list_todos` binding is refused.
 *
 * Nothing here adds an authority rule of its own:
 * - a tool binding runs the crew tool's own handler with a `CrewContext`
 *   built from the viewer, after the same `roleCan` check `mcp.ts` makes for
 *   a chat, so each tool keeps its `permission`;
 * - a view binding is the `run_view` crew tool under that same context: the
 *   grown store's visibility for the viewer (a member reads a view only once
 *   it is published, and then its published revision), then `runView`, so a
 *   view reads the same rows on its page, in First Mate and on a surface.
 *
 * Each binding resolves on its own: one that fails (a view the viewer cannot
 * see, a project that left the catalogue, a Dolt outage) comes back as an
 * error value next to the others, so one broken tile does not blank a whole
 * surface. Results are bounded by the crew tools' `RESULT_MAX_CHARS`.
 */
import { roleCan } from '../auth/roles.js';
import { safeError } from '../security.js';
import {
	boundedJson,
	CrewToolError,
	RESULT_MAX_CHARS,
	type CrewContext,
	type CrewDeps,
	type CrewTool
} from '../crew/registry.js';
import { createLaunchLimiter, type LaunchLimiter } from '../crew/launch-limit.js';
import {
	BRIDGE_READS,
	BRIDGE_VIEW_TOOL,
	bridgeTool,
	type BridgeReadName,
	type BridgeYield
} from './bridge.js';
import { GrownError } from './errors.js';
import type { GrownStore, GrownThing, GrownViewer } from './store.js';
import { surface_spec_schema, type SurfaceBinding } from './surface-spec.js';
import type { SurfaceBindingResult } from '#lib/surfaces.js';

/** Bridge calls one viewer may make per open surface per window (ADR-0025 limits). */
export const BRIDGE_CALLS_PER_WINDOW = 60;
export const BRIDGE_WINDOW_MS = 60_000;

/** The viewer, plus the email a crew context records as the actor. */
export interface BridgeViewer extends GrownViewer {
	actor: string;
}

export interface BindingDeps {
	/** Crew tool modules (discovery, read plane, todos); production defaults when omitted. */
	crew?: CrewDeps;
	/** The crew tool behind a bridge name; tests may substitute one. */
	tool?: (name: BridgeToolName) => Promise<CrewTool>;
}

/** The crew tools a binding may run: the bridge reads, and `run_view` for a view binding. */
export type BridgeToolName = BridgeReadName | typeof BRIDGE_VIEW_TOOL;

/** The grown kinds that reach Beadsmith over the bridge. */
export type BridgeKind = 'surface' | 'app';

/**
 * The context a bridge read or action runs a crew tool under: the viewer's
 * account and role. A grown thing has no chat, so `chat_id` names the
 * grown thing and the viewer (it keys the per-chat launch limit and a
 * launch's idempotency, so one viewer's clicks never replay or spend
 * another's), and `grown_slug` makes a launch record the grown thing instead
 * of a chat. `scope` is null: every project-defaulting tool must name its
 * project (checked when a surface is saved, and on every app call).
 * @param viewer The signed-in viewer.
 * @param slug The surface or app being read.
 * @param kind Which kind it is; slugs are unique across kinds, so this only labels the id.
 */
export function bridgeContext(
	viewer: BridgeViewer,
	slug: string,
	kind: BridgeKind = 'surface'
): CrewContext {
	return {
		account_id: viewer.account_id,
		actor: viewer.actor,
		role: viewer.role,
		chat_id: `${kind}:${slug}:${viewer.account_id}`,
		scope: null,
		grown_slug: slug
	};
}

/** The list a read yields, so an oversized result can be cut by whole items. */
const LIST_KEY: Partial<Record<BridgeYield, string>> = {
	issues: 'issues',
	projects: 'projects',
	missions: 'missions',
	todos: 'todos'
};

/**
 * Bound a result to `RESULT_MAX_CHARS` without ever handing the renderer cut
 * JSON. Long strings are shortened first (`boundedJson`); if the result still
 * does not fit and it is a list, whole items are dropped from the end, and
 * `total` keeps the full count so a stat tile still counts every row. A
 * result that cannot fit either way is an error the owner can act on.
 */
function bounded(yields: BridgeYield, value: unknown): SurfaceBindingResult {
	const fits = (candidate: unknown): unknown => {
		const text = boundedJson(candidate);
		if (text.length > RESULT_MAX_CHARS) return undefined;
		try {
			return JSON.parse(text) as unknown;
		} catch {
			return undefined; // `boundedJson` cut the text itself.
		}
	};
	const whole = fits(value);
	if (whole !== undefined) return { ok: true, yields, data: whole };

	const key = LIST_KEY[yields];
	const list =
		key !== undefined && value !== null && typeof value === 'object'
			? (value as Record<string, unknown>)[key]
			: undefined;
	if (key !== undefined && Array.isArray(list)) {
		let keep = list.length;
		while (keep > 1) {
			keep = Math.floor(keep / 2);
			const cut = fits({ ...(value as object), [key]: list.slice(0, keep), total: list.length });
			if (cut !== undefined) return { ok: true, yields, data: cut, truncated: true };
		}
	}
	return {
		ok: false,
		code: 'bad_request',
		message: `The result is larger than ${RESULT_MAX_CHARS} characters. Lower the binding's limit.`
	};
}

/** A thrown refusal or failure as a binding's error value; driver detail never leaves. */
export function bridgeFailure(error: unknown): SurfaceBindingResult {
	if (error instanceof CrewToolError) {
		return { ok: false, code: 'bad_request', message: error.message };
	}
	const safe = safeError(error);
	return { ok: false, code: safe.code, message: safe.message };
}

/** True when an app's `tools/call` names a read on the bridge allowlist (or `run_view`). */
export function isBridgeRead(name: string): name is BridgeToolName {
	return name === BRIDGE_VIEW_TOOL || Object.hasOwn(BRIDGE_READS, name);
}

/**
 * Run one allowlisted read as the viewer: the crew tool's own `permission`
 * checked against the viewer's role (the check `mcp.ts` makes for a chat, so
 * an admin's surface or app does not lend a member its permissions), the
 * stored or sent input parsed by the tool's own schema, then its handler
 * under `bridgeContext`, the result bounded as `bounded` describes.
 * Refusals come back as error values; a thrown failure is the caller's.
 * @param store The grown things store, for `run_view`.
 * @param viewer The signed-in viewer.
 * @param thing Which surface or app is reading.
 * @param name The read (a bridge read, or `run_view`).
 * @param input Its input: a surface's stored one, or an app's call arguments.
 * @param deps Injectable crew and tool dependencies.
 */
export async function runBridgeRead(
	store: GrownStore,
	viewer: BridgeViewer,
	thing: { slug: string; kind: BridgeKind },
	name: BridgeToolName,
	input: Record<string, unknown>,
	deps: BindingDeps = {}
): Promise<SurfaceBindingResult> {
	const yields: BridgeYield = name === BRIDGE_VIEW_TOOL ? 'issues' : BRIDGE_READS[name].yields;
	const tool = await (deps.tool ?? bridgeTool)(name);
	if (tool.permission !== undefined && !roleCan(viewer.role, tool.permission)) {
		return {
			ok: false,
			code: 'forbidden',
			message: `${tool.name} needs an admin account; this ${thing.kind} reads as you.`
		};
	}
	// A surface's inputs were checked when it was saved; an app's arrive with
	// each call, so the project rule is checked here for both.
	if (
		name !== BRIDGE_VIEW_TOOL &&
		BRIDGE_READS[name].needs_project &&
		input.project === undefined
	) {
		return {
			ok: false,
			code: 'bad_request',
			message: `${tool.name} needs a project: ${thing.kind === 'app' ? 'an app' : 'a surface'} has no chat project to default to.`
		};
	}
	// Parsed again for its defaults, and so a stored input today's schema
	// refuses is refused, not run.
	const parsed = tool.input.safeParse(input);
	if (!parsed.success) {
		const detail = parsed.error.issues
			.slice(0, 3)
			.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
			.join('; ');
		return {
			ok: false,
			code: 'bad_request',
			message:
				thing.kind === 'surface'
					? `The input for ${tool.name} is no longer valid. Edit the surface.`
					: `The input for ${tool.name} is not valid: ${detail}`
		};
	}
	const crew: CrewDeps = { ...deps.crew, grown: async () => store };
	const value = await tool.handler(
		bridgeContext(viewer, thing.slug, thing.kind),
		parsed.data,
		crew,
		{
			id: `${thing.kind}:${thing.slug}:${name}`
		}
	);
	return bounded(yields, value);
}

function resolveTool(
	store: GrownStore,
	viewer: BridgeViewer,
	slug: string,
	binding: SurfaceBinding,
	deps: BindingDeps
): Promise<SurfaceBindingResult> {
	const [name, stored]: [BridgeToolName, Record<string, unknown>] =
		'view' in binding ? [BRIDGE_VIEW_TOOL, { slug: binding.view }] : [binding.tool, binding.input];
	return runBridgeRead(store, viewer, { slug, kind: 'surface' }, name, stored, deps);
}

/**
 * The bindings a request asks for, checked against the surface the viewer
 * sees: every one when none is named, each name once, and an unknown name
 * refused before anything is charged or run.
 * @param surface The surface as the store returned it for this viewer.
 * @param asked Binding names from the request, possibly empty.
 */
export function surfaceBindingNames(surface: GrownThing, asked: string[] = []): string[] {
	// The store validated the spec on write; parsing again types it and
	// refuses a stored spec today's schema no longer accepts.
	const { data } = surface_spec_schema.parse(surface.revision.spec);
	if (asked.length === 0) return Object.keys(data);
	for (const name of asked) {
		if (!Object.hasOwn(data, name)) {
			throw new GrownError('bad_request', `The surface has no data binding "${name}".`);
		}
	}
	return [...new Set(asked)];
}

/**
 * Resolve the named bindings of a surface the viewer can see (the caller has
 * read it from the store as this viewer, so `surface.revision` is the one
 * they see: a member gets the published revision's bindings).
 * @param store The grown things store, for view bindings.
 * @param viewer The signed-in viewer.
 * @param surface The surface as the store returned it for this viewer.
 * @param names Bindings to resolve (`surfaceBindingNames`); all when omitted.
 * @param deps Injectable crew, view and tool dependencies.
 */
export async function resolveSurfaceBindings(
	store: GrownStore,
	viewer: BridgeViewer,
	surface: GrownThing,
	names?: string[],
	deps: BindingDeps = {}
): Promise<Record<string, SurfaceBindingResult>> {
	const { data } = surface_spec_schema.parse(surface.revision.spec);
	const entries = await Promise.all(
		surfaceBindingNames(surface, names).map(
			async (name): Promise<[string, SurfaceBindingResult]> => {
				const binding = data[name];
				try {
					return [name, await resolveTool(store, viewer, surface.slug, binding, deps)];
				} catch (error) {
					return [name, bridgeFailure(error)];
				}
			}
		)
	);
	return Object.fromEntries(entries);
}

let default_limiter: LaunchLimiter | undefined;

/**
 * The bridge's call limiter: the crew launch cap's sliding window, sized for
 * the bridge and keyed per viewer and surface, so one open surface polling
 * hard cannot starve another, and a member cannot spend an admin's budget.
 */
export function getBridgeLimiter(): LaunchLimiter {
	default_limiter ??= createLaunchLimiter({
		count: BRIDGE_CALLS_PER_WINDOW,
		window_ms: BRIDGE_WINDOW_MS
	});
	return default_limiter;
}

/**
 * Take one bridge call per binding for this viewer's open surface, all or
 * none: a request that would cross the limit takes nothing and says how long
 * to wait.
 * @param limiter The bridge limiter.
 * @param viewer The viewer.
 * @param slug The open surface.
 * @param calls Bindings this request resolves.
 */
export function takeBridgeCalls(
	limiter: LaunchLimiter,
	viewer: GrownViewer,
	slug: string,
	calls: number
): { ok: true } | { ok: false; retry_after_ms: number } {
	const key = `${viewer.account_id}\0${slug}`;
	const taken: { release(): void }[] = [];
	for (let index = 0; index < calls; index += 1) {
		const slot = limiter.acquire(key);
		if (!slot.ok) {
			for (const each of taken) each.release();
			return { ok: false, retry_after_ms: slot.retry_after_ms };
		}
		taken.push(slot.slot);
	}
	return { ok: true };
}

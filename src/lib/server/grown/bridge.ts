/**
 * The grown things' tool bridge allowlist (ADR-0025 rule 6), in one place so
 * surfaces and apps share it. A surface binding or button, and later an app's
 * `tools/call`, may name only a tool listed here; each is the crew tool of
 * that name, so its input schema, `permission` and handler are the ones First
 * Mate uses and nothing here adds a rule of its own.
 *
 * Chat-bound tools (memory, meta folder, mission follow-ups and cancels,
 * notices) are not listed: a grown thing has no chat. Neither are the grown
 * thing tools themselves, so a surface can never write or publish another.
 */
import type { CrewTool } from '../crew/registry.js';

/** What a read returns, so a surface can check a component can show it. */
export type BridgeYield = 'issues' | 'issue' | 'projects' | 'missions' | 'mission' | 'todos';

interface BridgeEntry {
	/**
	 * In a chat, an omitted `project` means the chat's project. A grown thing
	 * has no chat, so these tools must name one.
	 */
	needs_project: boolean;
}

interface BridgeRead extends BridgeEntry {
	yields: BridgeYield;
}

/** Reads (no confirmation). Each keeps its own `permission`: `list_todos` answers admins only. */
export const BRIDGE_READS = {
	list_projects: { needs_project: false, yields: 'projects' },
	ready_work: { needs_project: false, yields: 'issues' },
	list_issues: { needs_project: true, yields: 'issues' },
	show_issue: { needs_project: true, yields: 'issue' },
	list_missions: { needs_project: false, yields: 'missions' },
	show_mission: { needs_project: false, yields: 'mission' },
	list_todos: { needs_project: false, yields: 'todos' }
} satisfies Record<string, BridgeRead>;

/**
 * Actions: only ones that reuse existing authority (todo changes, and mission
 * launches through dispatch under the arm, per-project allow and repository
 * map). Every one needs a host-rendered confirmation before it runs.
 */
export const BRIDGE_ACTIONS = {
	create_todo: { needs_project: false },
	update_todo: { needs_project: false },
	complete_todo: { needs_project: false },
	file_issue: { needs_project: true },
	comment_issue: { needs_project: true },
	tackle_issue: { needs_project: true },
	discuss_issue: { needs_project: true }
} satisfies Record<string, BridgeEntry>;

export type BridgeReadName = keyof typeof BRIDGE_READS;
export type BridgeActionName = keyof typeof BRIDGE_ACTIONS;

export const BRIDGE_READ_NAMES = Object.keys(BRIDGE_READS) as [BridgeReadName, ...BridgeReadName[]];
export const BRIDGE_ACTION_NAMES = Object.keys(BRIDGE_ACTIONS) as [
	BridgeActionName,
	...BridgeActionName[]
];

/**
 * The crew tool behind an allowlisted name. Loaded on first use, not
 * imported: the crew modules import the state database, which imports the
 * grown store, which imports this file, and a static import would evaluate
 * the crew registry before its tools exist.
 * @param name An allowlisted read or action.
 */
export async function bridgeTool(name: BridgeReadName | BridgeActionName): Promise<CrewTool> {
	// Through `mcp.ts`, the registry's entry point, which loads the tool
	// modules in the order their own imports need.
	const { CREW_TOOLS } = await import('../crew/mcp.js');
	const tool = CREW_TOOLS.find((entry) => entry.name === name);
	if (tool === undefined) throw new Error(`bridge tool ${name} is not a crew tool`);
	return tool;
}

/**
 * Check a stored tool input against the crew tool's own schema, so a bad
 * input is refused when the grown thing is saved rather than when a viewer
 * opens it. Returns the problems, empty when the input is valid.
 * @param name An allowlisted read or action.
 * @param input The input the grown thing stores.
 */
export async function bridgeInputProblems(
	name: BridgeReadName | BridgeActionName,
	input: Record<string, unknown>
): Promise<string[]> {
	const entry: BridgeEntry = Object.hasOwn(BRIDGE_READS, name)
		? BRIDGE_READS[name as BridgeReadName]
		: BRIDGE_ACTIONS[name as BridgeActionName];
	const problems: string[] = [];
	if (entry.needs_project && input.project === undefined) {
		problems.push('project: name the project; a grown thing has no chat project to default to');
	}
	const parsed = (await bridgeTool(name)).input.safeParse(input);
	if (!parsed.success) {
		for (const issue of parsed.error.issues.slice(0, 3)) {
			problems.push(`${issue.path.join('.') || 'input'}: ${issue.message}`);
		}
	}
	return problems;
}

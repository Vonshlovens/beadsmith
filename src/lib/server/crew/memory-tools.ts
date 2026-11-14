/**
 * Crew memory tools (ADR-0024 rules 2 and 3): First Mate remembers, recalls
 * and forgets short facts in its owner's memory, which outlives the chat.
 * The agent writes on its own judgment; the owner reviews and edits them in
 * Beadsmith. Memories are notes, never work: work goes to Beads through
 * missions, and the captain's own tasks are todos.
 */
import { z } from 'zod';
import type { Permission } from '../auth/roles.js';
import { getMemoryStore } from '../state/db.js';
import {
	MEMORY_BODY_MAX,
	MEMORY_KEY_MAX,
	MEMORY_SLUG_PATTERN,
	MEMORY_TOPIC_MAX,
	MemoryLimitError,
	RECALL_MAX,
	type Memory,
	type MemoryScope,
	type MemoryStore
} from '../mate/memory-store.js';
import { resolveCrewProject } from './read-tools.js';
import {
	CrewToolError,
	defineTool,
	type CrewContext,
	type CrewDeps,
	type CrewTool
} from './registry.js';

/** First Mate is admin-only; its memory needs what `/api/todos` needs (roles.ts). */
const MEMORY_PERMISSION: Permission = { console: ['manage'] };

const key_schema = z
	.string()
	.max(MEMORY_KEY_MAX)
	.regex(MEMORY_SLUG_PATTERN, 'lowercase letters, digits and single dashes')
	.describe(
		`Short stable name for the fact, up to ${MEMORY_KEY_MAX} characters of lowercase ` +
			'letters, digits and dashes (e.g. "deploy-window"). Reuse a key to update that memory.'
	);

const scope_kind_schema = z
	.enum(['owner', 'project', 'topic'])
	.describe(
		'owner: about the captain, recalled every turn (keep these few). project: about one ' +
			'project. topic: about a subject that spans projects.'
	);

const project_schema = z
	.string()
	.regex(/^[A-Za-z0-9_-]{1,80}$/, 'invalid project')
	.describe('For scope project: project id (d_…) or database name. Omit for the chat’s project.');

const topic_schema = z
	.string()
	.max(MEMORY_TOPIC_MAX)
	.regex(MEMORY_SLUG_PATTERN, 'lowercase letters, digits and single dashes')
	.describe(`For scope topic: a slug of up to ${MEMORY_TOPIC_MAX} characters (e.g. "backups").`);

function memoryStore(deps: CrewDeps): Promise<MemoryStore> {
	return (deps.memories ?? getMemoryStore)();
}

/** The stored scope for a tool's `scope`, `project` and `topic` fields. */
async function resolveScope(
	ctx: CrewContext,
	deps: CrewDeps,
	input: { scope: 'owner' | 'project' | 'topic'; project?: string; topic?: string }
): Promise<MemoryScope> {
	switch (input.scope) {
		case 'owner':
			return 'owner';
		case 'project': {
			const project = await resolveCrewProject(ctx, deps, input.project);
			return `project:${project.id}`;
		}
		case 'topic':
			if (input.topic === undefined) {
				throw new CrewToolError('Scope topic needs topic, a slug such as "backups".');
			}
			return `topic:${input.topic}`;
	}
}

/** What the model sees of a memory. */
function compactMemory(memory: Memory) {
	return {
		key: memory.key,
		scope: memory.scope,
		body: memory.body,
		updated_at: memory.updated_at
	};
}

export const remember = defineTool({
	name: 'remember',
	description:
		'Save one short fact to the captain’s memory, kept across chats: a preference, a ' +
		'decision, how a project works. One fact per memory, at most ' +
		`${MEMORY_BODY_MAX} characters. Saving under an existing key replaces it, so update ` +
		'rather than duplicate. Not for work to do: file that as an issue, or add a todo ' +
		'for the captain.',
	input: z.strictObject({
		key: key_schema,
		body: z.string().trim().min(1).max(MEMORY_BODY_MAX).describe('The fact, in a sentence or two.'),
		scope: scope_kind_schema,
		project: project_schema.optional(),
		topic: topic_schema.optional()
	}),
	permission: MEMORY_PERMISSION,
	async handler(ctx, input, deps) {
		const scope = await resolveScope(ctx, deps, input);
		const store = await memoryStore(deps);
		try {
			const { memory, created } = await store.remember(ctx.account_id, {
				key: input.key,
				scope,
				body: input.body,
				source_chat_id: ctx.chat_id
			});
			const counts = await store.counts(ctx.account_id);
			return { remembered: created ? 'created' : 'updated', memory: compactMemory(memory), counts };
		} catch (error) {
			if (error instanceof MemoryLimitError) throw new CrewToolError(error.message);
			throw error;
		}
	}
});

export const recall = defineTool({
	name: 'recall',
	description:
		'Search the captain’s memory. With query, the best matches for those words; without, ' +
		'the most recently updated. Narrow with scope (and project or topic). Returns at most ' +
		`${RECALL_MAX} memories and how many matched.`,
	input: z.strictObject({
		query: z.string().trim().min(1).max(500).optional().describe('Words to match.'),
		scope: scope_kind_schema.optional(),
		project: project_schema.optional(),
		topic: topic_schema.optional(),
		limit: z.number().int().min(1).max(RECALL_MAX).default(RECALL_MAX)
	}),
	permission: MEMORY_PERMISSION,
	async handler(ctx, input, deps) {
		const scope =
			input.scope === undefined
				? undefined
				: await resolveScope(ctx, deps, { ...input, scope: input.scope });
		const store = await memoryStore(deps);
		const { memories, total } = await store.recall(ctx.account_id, {
			...(input.query === undefined ? {} : { text: input.query }),
			...(scope === undefined ? {} : { scope }),
			limit: input.limit
		});
		await store.markRecalled(
			ctx.account_id,
			memories.map((memory) => memory.key)
		);
		return {
			memories: memories.map(compactMemory),
			total,
			...(total > memories.length
				? { note: `${total - memories.length} more matched; narrow the search.` }
				: {})
		};
	}
});

export const forget = defineTool({
	name: 'forget',
	description:
		'Delete one memory by key, when it is wrong or no longer true. To change a memory, ' +
		'remember it again under the same key instead.',
	input: z.strictObject({ key: key_schema }),
	permission: MEMORY_PERMISSION,
	async handler(ctx, input, deps) {
		const store = await memoryStore(deps);
		if (!(await store.forget(ctx.account_id, input.key))) {
			throw new CrewToolError(`No memory "${input.key}". Use recall to find the key.`);
		}
		return { forgot: input.key };
	}
});

export const MEMORY_TOOLS: CrewTool[] = [remember, recall, forget];

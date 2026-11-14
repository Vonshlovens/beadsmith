/**
 * Crew meta folder tools (ADR-0024 rule 5): First Mate's own workspace of
 * text files, kept per owner across chats. It organizes them as it sees fit.
 * The folder is for the agent's thinking, drafts and its own checklist;
 * work goes to Beads through missions, and the captain's tasks are todos.
 */
import { z } from 'zod';
import type { Permission } from '../auth/roles.js';
import { getMetaStore } from '../state/db.js';
import {
	META_CHARS_PER_OWNER,
	META_FILE_MAX,
	META_FILES_PER_OWNER,
	META_PATH_MAX,
	MetaLimitError,
	metaPathProblem,
	type MetaFileInfo,
	type MetaStore
} from '../mate/meta-store.js';
import { CrewText, CrewToolError, defineTool, type CrewDeps, type CrewTool } from './registry.js';

/** First Mate is admin-only; its folder needs what `/api/todos` needs (roles.ts). */
const META_PERMISSION: Permission = { console: ['manage'] };

const path_schema = z
	.string()
	.max(META_PATH_MAX)
	.refine((path) => metaPathProblem(path) === undefined, {
		message: 'relative path like "notes/deploys.md": letters, digits, ".", "_", "-"; no ".."'
	})
	.describe('File path in the meta folder, like "notes/deploys.md".');

function metaStore(deps: CrewDeps): Promise<MetaStore> {
	return (deps.meta ?? getMetaStore)();
}

/** What the model sees of a file's metadata. */
function compactInfo(file: MetaFileInfo) {
	return { path: file.path, chars: file.chars, updated_at: file.updated_at };
}

/** Rethrow a refused write as a message the model reads. */
function refusal(error: unknown): never {
	if (error instanceof MetaLimitError) throw new CrewToolError(error.message);
	throw error;
}

export const meta_list = defineTool({
	name: 'meta_list',
	description:
		'List the files in your meta folder: your own workspace, kept across chats, for notes, ' +
		'drafts, docs for yourself and your checklist. Optionally only under one folder. ' +
		'Returns paths, sizes and how much room is left.',
	input: z.strictObject({
		folder: z
			.string()
			.max(META_PATH_MAX)
			.optional()
			.describe('Only files under this folder, like "notes".')
	}),
	permission: META_PERMISSION,
	async handler(ctx, input, deps) {
		const store = await metaStore(deps);
		const [files, usage] = await Promise.all([
			store.list(ctx.account_id, input.folder),
			store.usage(ctx.account_id)
		]);
		return {
			files: files.map(compactInfo),
			usage: {
				files: usage.files,
				files_max: META_FILES_PER_OWNER,
				chars: usage.chars,
				chars_max: META_CHARS_PER_OWNER
			}
		};
	}
});

export const meta_read = defineTool({
	name: 'meta_read',
	description: 'Read one file from your meta folder, whole.',
	input: z.strictObject({ path: path_schema }),
	permission: META_PERMISSION,
	async handler(ctx, input, deps) {
		const file = await (await metaStore(deps)).read(ctx.account_id, input.path);
		if (file === undefined) {
			throw new CrewToolError(`No file "${input.path}". Use meta_list to see what is there.`);
		}
		return new CrewText(
			`${file.path} (${file.chars} chars, updated ${file.updated_at})\n\n${file.content}`
		);
	}
});

export const meta_write = defineTool({
	name: 'meta_write',
	description:
		'Create or replace a file in your meta folder, or append to it (creating it if missing). ' +
		`At most ${META_FILE_MAX} characters per file. Folders exist as path prefixes; there is ` +
		'nothing to create first.',
	input: z.strictObject({
		path: path_schema,
		content: z.string().max(META_FILE_MAX),
		append: z.boolean().default(false).describe('Add to the end instead of replacing.')
	}),
	permission: META_PERMISSION,
	async handler(ctx, input, deps) {
		const store = await metaStore(deps);
		try {
			const { file, created } = await store.write(ctx.account_id, {
				path: input.path,
				content: input.content,
				append: input.append,
				source_chat_id: ctx.chat_id
			});
			return {
				written: created ? 'created' : input.append ? 'appended' : 'replaced',
				file: compactInfo(file)
			};
		} catch (error) {
			refusal(error);
		}
	}
});

export const meta_move = defineTool({
	name: 'meta_move',
	description: 'Rename or move one file in your meta folder. Refused if the new path exists.',
	input: z.strictObject({ from: path_schema, to: path_schema }),
	permission: META_PERMISSION,
	async handler(ctx, input, deps) {
		const store = await metaStore(deps);
		let file: MetaFileInfo | undefined;
		try {
			file = await store.move(ctx.account_id, input.from, input.to);
		} catch (error) {
			refusal(error);
		}
		if (file === undefined) {
			throw new CrewToolError(`No file "${input.from}". Use meta_list to see what is there.`);
		}
		return { moved: { from: input.from, to: input.to }, file: compactInfo(file) };
	}
});

export const meta_delete = defineTool({
	name: 'meta_delete',
	description: 'Delete one file from your meta folder.',
	input: z.strictObject({ path: path_schema }),
	permission: META_PERMISSION,
	async handler(ctx, input, deps) {
		if (!(await (await metaStore(deps)).remove(ctx.account_id, input.path))) {
			throw new CrewToolError(`No file "${input.path}". Use meta_list to see what is there.`);
		}
		return { deleted: input.path };
	}
});

export const META_TOOLS: CrewTool[] = [meta_list, meta_read, meta_write, meta_move, meta_delete];

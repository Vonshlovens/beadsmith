<script lang="ts">
	/**
	 * The tuxedo-style list over the same todos: one dense
	 * monospace row per todo, driven from the keyboard. State and mutations
	 * live here; the pure parts are in `$lib/todos/{keymap,sort,query,lines,
	 * selection,undo}`. Keys are registered through `useHotkeys`, so they stay
	 * inert in fields and under dialogs, and appear in the `?` overlay.
	 */
	import { onMount, tick, untrack } from 'svelte';
	import { flip } from 'svelte/animate';
	import { toast } from 'svelte-sonner';
	import EmptyState from '$lib/components/empty-state.svelte';
	import { api, errorMessage } from '$lib/client/api';
	import { pendingKeys, useHotkeys } from '$lib/client/hotkeys.svelte';
	import { dur } from '$lib/client/motion';
	import type { Todo, TodoComment } from '$lib/server/todos/store';
	import { dueLabel } from '$lib/todos/dates';
	import {
		listBindings,
		modeLabel,
		paletteEntries,
		type ActionHandler,
		type ListMode
	} from '$lib/todos/keymap';
	import { bodyLine, editLine, nextPriority, rawLine, toggleTag } from '$lib/todos/lines';
	import { parseCapture } from '$lib/todos/parse';
	import {
		cycleFilter,
		defaultFilterName,
		matchesQuery,
		tagCounts,
		type SavedFilters
	} from '$lib/todos/query';
	import { flipRow, moveCursor, selectedIds, startVisual, type Visual } from '$lib/todos/selection';
	import {
		cycleSort,
		groupByCompletion,
		groupByDue,
		parseSortMode,
		reorderPatches,
		sortTodos,
		type Group,
		type SortMode
	} from '$lib/todos/sort';
	import { UndoStack, type Restore, type UndoEntry } from '$lib/todos/undo';
	import { urgency } from '$lib/todos/urgency';

	let {
		todos = $bindable(),
		done_todos = $bindable(),
		now,
		onroute,
		ensureDone
	}: {
		todos: Todo[];
		done_todos: Todo[];
		now: Date;
		onroute: (todo: Todo) => void;
		/** Load completed todos if they are not loaded yet. */
		ensureDone: () => Promise<void>;
	} = $props();

	type Density = 'compact' | 'comfortable' | 'cozy';
	type PromptKind = 'search' | 'add' | 'edit' | 'context' | 'project' | 'save' | 'command';
	interface Prompt {
		kind: PromptKind;
		text: string;
		/** Search: the query to restore on Esc. */
		before?: string;
		/** Edit: the todo being edited. */
		id?: string;
	}
	interface Pick {
		kind: 'project' | 'context' | 'saved';
		before: { query: string; project: string | null; context: string | null; saved: string | null };
	}

	const PREFS_KEY = 'bdui:todos-list';
	const ROW_HEIGHT: Record<Density, number> = { compact: 24, comfortable: 30, cozy: 38 };

	let sort = $state<SortMode>('urgency');
	let density = $state<Density>('comfortable');
	let numbers = $state(false);
	let sidebar_open = $state(true);
	let detail_open = $state(false);
	let show_done = $state(false);
	let archive_view = $state(false);

	let query = $state('');
	let filter_project = $state<string | null>(null);
	let filter_context = $state<string | null>(null);
	let active_saved = $state<string | null>(null);
	let saved = $state<SavedFilters>({});

	let cursor_id = $state<string | null>(null);
	let last_index = 0;
	let visual = $state<Visual | null>(null);
	let prompt = $state<Prompt | null>(null);
	let pick = $state<Pick | null>(null);
	let palette_index = $state(0);
	let flash = $state('');
	let flash_timer: ReturnType<typeof setTimeout> | undefined;
	let undo_size = $state(0);
	const undo = new UndoStack();

	let list_el = $state<HTMLElement | null>(null);
	let input_el = $state<HTMLInputElement | null>(null);
	let width = $state(1000);
	let comments = $state<TodoComment[]>([]);

	const narrow = $derived(width < 760);
	const mode = $derived<ListMode>(
		prompt !== null
			? prompt.kind === 'search'
				? 'search'
				: prompt.kind === 'command'
					? 'command'
					: 'insert'
			: pick !== null
				? 'pick'
				: visual !== null
					? 'visual'
					: 'normal'
	);

	const source = $derived(
		archive_view ? done_todos : show_done ? [...todos, ...done_todos] : todos
	);
	const effective_query = $derived(
		[filter_project, filter_context, query].filter((part) => part).join(' ')
	);
	const shown = $derived(source.filter((todo) => matchesQuery(todo, effective_query, now)));

	const groups = $derived.by<Group<Todo>[]>(() => {
		if (archive_view) {
			return groupByCompletion(shown);
		}
		const open = sortTodos(
			shown.filter((todo) => todo.status === 'open'),
			sort,
			now
		);
		const finished = groupByCompletion(shown.filter((todo) => todo.status === 'done')).flatMap(
			(group) => group.items
		);
		const out: Group<Todo>[] =
			sort === 'due' ? groupByDue(open, now) : [{ key: 'open', label: '', items: open }];
		if (finished.length > 0) {
			out.push({ key: 'done', label: 'Done', items: finished });
		}
		return out.filter((group) => group.items.length > 0);
	});
	const rows = $derived(groups.flatMap((group) => group.items));
	const row_ids = $derived(rows.map((row) => row.id));
	const cursor_todo = $derived(rows.find((row) => row.id === cursor_id));
	const selection = $derived(
		visual !== null && cursor_id !== null ? selectedIds(visual, row_ids, cursor_id) : []
	);
	const selection_set = $derived(new Set(selection));

	const projects = $derived(tagCounts(source, '+'));
	const contexts = $derived(tagCounts(source, '@'));
	const saved_counts = $derived(
		Object.entries(saved).map(([name, text]) => ({
			name,
			text,
			count: source.filter((todo) => matchesQuery(todo, text, now)).length
		}))
	);
	const palette = $derived(
		prompt?.kind === 'command' ? paletteEntries(prompt.text, 'normal', live) : []
	);
	const chord = $derived(pendingKeys());
	const chip = $derived(modeLabel(mode, chord));

	// ---- persistence ----------------------------------------------------------

	onMount(() => {
		try {
			const stored = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? '{}') as Record<
				string,
				unknown
			>;
			sort = parseSortMode(stored.sort as string);
			if (stored.density === 'compact' || stored.density === 'cozy') density = stored.density;
			numbers = stored.numbers === true;
			if (typeof stored.sidebar === 'boolean') sidebar_open = stored.sidebar;
			detail_open = stored.detail === true;
			show_done = stored.show_done === true;
		} catch {
			/* private window or junk: defaults */
		}
		if (width < 760) sidebar_open = false;
		if (show_done) void ensureDone();
		void api
			.todoFilters()
			.then((result) => (saved = result.filters))
			.catch(() => undefined);
		list_el?.focus({ preventScroll: true });
	});

	$effect(() => {
		const prefs = { sort, density, numbers, sidebar: sidebar_open, detail: detail_open, show_done };
		try {
			window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
		} catch {
			/* storage unavailable */
		}
	});

	// ---- cursor ---------------------------------------------------------------

	function setCursor(id: string | null) {
		cursor_id = id;
		const at = id === null ? -1 : untrack(() => row_ids).indexOf(id);
		if (at !== -1) last_index = at;
	}

	// Keep the cursor on a real row: when its row leaves, take the neighbour.
	$effect(() => {
		const ids = row_ids;
		if (cursor_id === null || !ids.includes(cursor_id)) {
			untrack(() => {
				cursor_id = ids.length === 0 ? null : ids[Math.min(last_index, ids.length - 1)];
			});
		}
	});

	$effect(() => {
		const id = cursor_id;
		if (id === null || list_el === null) return;
		list_el.querySelector(`[data-row="${id}"]`)?.scrollIntoView({ block: 'nearest' });
	});

	// The detail pane's comments follow the cursor.
	$effect(() => {
		const id = detail_open ? cursor_id : null;
		comments = [];
		if (id === null) return;
		let stale = false;
		void api
			.todoComments(id)
			.then((result) => {
				if (!stale) comments = result.comments;
			})
			.catch(() => undefined);
		return () => (stale = true);
	});

	function say(message: string) {
		flash = message;
		clearTimeout(flash_timer);
		flash_timer = setTimeout(() => (flash = ''), 2600);
	}

	function pageSize(): number {
		const height = list_el?.clientHeight ?? 400;
		return Math.max(2, Math.floor(height / ROW_HEIGHT[density]));
	}

	// ---- mutations --------------------------------------------------------------

	/** File `next` in the open or done list by its status (archived leaves both). */
	function put(next: Todo) {
		todos = todos.filter((item) => item.id !== next.id);
		done_todos = done_todos.filter((item) => item.id !== next.id);
		if (next.status === 'open') todos = [...todos, next];
		else if (next.status === 'done') done_todos = [...done_todos, next];
	}

	function find(id: string): Todo | undefined {
		return todos.find((item) => item.id === id) ?? done_todos.find((item) => item.id === id);
	}

	function patched(todo: Todo, fields: Restore): Todo {
		const next: Todo = { ...todo, ...fields };
		if (fields.status === 'done' && todo.status !== 'done')
			next.completed_at = new Date().toISOString();
		if (fields.status === 'open') next.completed_at = null;
		return next;
	}

	/**
	 * Apply field changes optimistically and send them. A row the server refuses
	 * rolls back on its own; rows that saved stay saved and stay undoable. Every
	 * call with at least one saved row is one undo level. Resolves to how many
	 * rows the server saved.
	 */
	async function apply(
		changes: { id: string; fields: Restore }[],
		label: string,
		record = true
	): Promise<number> {
		// Undo may name a todo that left both lists (archived): it is sent without a local preview.
		const pairs = changes.map((change) => ({ change, old: find(change.id) }));
		const known = pairs.filter(
			(pair): pair is { change: (typeof changes)[number]; old: Todo } => pair.old !== undefined
		);
		if (pairs.length === 0) return 0;
		const entry: UndoEntry = {
			label,
			restores: known.map(({ change, old }) => ({
				id: change.id,
				fields: Object.fromEntries(
					Object.keys(change.fields).map((key) => [
						key,
						(old as unknown as Record<string, unknown>)[key]
					])
				) as Restore
			}))
		};
		if (record) {
			undo.push(entry);
			undo_size = undo.size;
		}
		for (const { change, old } of known) put(patched(old, change.fields));
		const results = await Promise.allSettled(
			pairs.map(({ change }) => api.updateTodo(change.id, change.fields))
		);
		const saved = new Set<string>();
		let failed = 0;
		let first_error: unknown;
		results.forEach((result, index) => {
			const { change, old } = pairs[index];
			if (result.status === 'fulfilled') {
				put(result.value.todo);
				saved.add(change.id);
			} else {
				failed += 1;
				first_error ??= result.reason;
				// Roll back only this row; the server kept the old values.
				if (old !== undefined) put(old);
			}
		});
		if (failed === 0) return saved.size;
		if (record) {
			entry.restores = entry.restores.filter((restore) => saved.has(restore.id));
			// Newer changes may have landed while these were in flight: drop this one in place.
			if (entry.restores.length === 0) undo.remove(entry);
			undo_size = undo.size;
		}
		toast.error(
			failed === pairs.length
				? `Could not ${label}`
				: `Could not ${label} for ${failed} of ${pairs.length}`,
			{ description: errorMessage(first_error) }
		);
		return saved.size;
	}

	/** `A`: archive every completed todo. Above a few it needs a second `A` within 5 s. */
	const ARCHIVE_ALL_CONFIRM_ABOVE = 3;
	let archive_armed = false;
	let archive_armed_timer: ReturnType<typeof setTimeout> | undefined;

	async function archiveDone() {
		await ensureDone();
		const finished = done_todos.filter((todo) => todo.status === 'done');
		if (finished.length === 0) {
			say('No completed todos to archive');
			return;
		}
		if (finished.length > ARCHIVE_ALL_CONFIRM_ABOVE && !archive_armed) {
			archive_armed = true;
			clearTimeout(archive_armed_timer);
			archive_armed_timer = setTimeout(() => (archive_armed = false), 5000);
			say(`Archive ${finished.length} completed todos? Press A again (u undoes)`);
			return;
		}
		archive_armed = false;
		clearTimeout(archive_armed_timer);
		const archived = await apply(
			finished.map((todo) => ({ id: todo.id, fields: { status: 'archived' } })),
			'archive all completed'
		);
		// apply's toast reports any rows the server refused; say only what saved.
		if (archived > 0) {
			const count =
				archived === finished.length ? `${archived}` : `${archived} of ${finished.length}`;
			say(`Archived ${count} completed (u undoes)`);
		}
	}

	async function addTodo(text: string) {
		const parsed = parseCapture(text, now);
		if (parsed.title === '') return;
		try {
			const { todo } = await api.createTodo({
				title: parsed.title,
				priority: parsed.priority,
				due_at: parsed.due_at,
				tags: parsed.tags
			});
			put(todo);
			undo.push({ label: 'add', restores: [{ id: todo.id, fields: { status: 'archived' } }] });
			undo_size = undo.size;
			await tick();
			setCursor(todo.id);
		} catch (error) {
			toast.error('Could not add the todo', { description: errorMessage(error) });
		}
	}

	function targets(): Todo[] {
		const ids = visual !== null ? selection : cursor_id !== null ? [cursor_id] : [];
		return ids.flatMap((id) => rows.find((row) => row.id === id) ?? []);
	}

	function endVisual() {
		visual = null;
	}

	async function doUndo() {
		const entry = undo.pop();
		undo_size = undo.size;
		if (entry === undefined) {
			say('Nothing to undo');
			return;
		}
		say(`Undid ${entry.label}`);
		await apply(entry.restores, `undo ${entry.label}`, false);
	}

	async function copy(lines: string[]) {
		if (lines.length === 0) return;
		try {
			await navigator.clipboard.writeText(lines.join('\n'));
			say(`Copied ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`);
		} catch {
			say('Clipboard unavailable');
		}
	}

	// ---- modes: prompt, pick ----------------------------------------------------

	async function openPrompt(next: Prompt) {
		(document.activeElement as HTMLElement | null)?.blur?.();
		prompt = next;
		palette_index = 0;
		await tick();
		input_el?.focus({ preventScroll: true });
		if (next.kind === 'edit' && next.id !== undefined && editAtStart)
			input_el?.setSelectionRange(0, 0);
	}

	let editAtStart = false;

	function closePrompt() {
		prompt = null;
		void tick().then(() => list_el?.focus({ preventScroll: true }));
	}

	function cancelPrompt() {
		if (prompt?.kind === 'search') query = prompt.before ?? '';
		closePrompt();
	}

	function submitPrompt() {
		const current = prompt;
		if (current === null) return;
		const text = current.text.trim();
		switch (current.kind) {
			case 'search':
				active_saved = null;
				closePrompt();
				return;
			case 'add':
				closePrompt();
				void addTodo(text);
				return;
			case 'edit': {
				closePrompt();
				const todo = current.id === undefined ? undefined : find(current.id);
				const parsed = parseCapture(text, now);
				if (todo === undefined || parsed.title === '') return;
				void apply(
					[
						{
							id: todo.id,
							fields: {
								title: parsed.title,
								priority: parsed.priority_explicit ? parsed.priority : todo.priority,
								due_at: parsed.due_at,
								tags: parsed.tags
							}
						}
					],
					'edit'
				);
				return;
			}
			case 'context':
			case 'project': {
				const sigil = current.kind === 'context' ? '@' : '+';
				const chosen = targets();
				closePrompt();
				endVisual();
				void apply(
					chosen.map((todo) => ({
						id: todo.id,
						fields: { tags: toggleTag(todo.tags, text, sigil) }
					})),
					current.kind === 'context' ? 'toggle context' : 'toggle project'
				);
				return;
			}
			case 'save': {
				const name = text === '' ? defaultFilterName(effective_query) : text;
				closePrompt();
				void saveSearch(name);
				return;
			}
			case 'command': {
				const entry = palette[Math.min(palette_index, palette.length - 1)];
				closePrompt();
				if (entry !== undefined) void tick().then(() => handlers[entry.id]?.());
				return;
			}
		}
	}

	function onPromptKey(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			cancelPrompt();
		} else if (event.key === 'Enter' && !event.isComposing) {
			event.preventDefault();
			submitPrompt();
		} else if (
			prompt?.kind === 'command' &&
			(event.key === 'ArrowDown' || event.key === 'ArrowUp')
		) {
			event.preventDefault();
			const last = Math.max(0, palette.length - 1);
			palette_index = Math.min(
				last,
				Math.max(0, palette_index + (event.key === 'ArrowDown' ? 1 : -1))
			);
		}
	}

	function onPromptInput() {
		if (prompt?.kind === 'search') {
			query = prompt.text;
			active_saved = null;
		}
		palette_index = 0;
	}

	async function saveSearch(name: string) {
		if (effective_query === '') {
			say('Nothing to save: search or filter first');
			return;
		}
		const before = saved;
		saved = { ...saved, [name]: effective_query };
		try {
			saved = (await api.saveTodoFilters(saved)).filters;
			active_saved = name;
			say(`Saved “${name}”`);
		} catch (error) {
			saved = before;
			toast.error('Could not save the search', { description: errorMessage(error) });
		}
	}

	async function deleteSaved(name: string) {
		const before = saved;
		const { [name]: _gone, ...rest } = saved;
		saved = rest;
		try {
			await api.saveTodoFilters(rest);
			if (active_saved === name) active_saved = null;
		} catch (error) {
			saved = before;
			toast.error('Could not remove the search', { description: errorMessage(error) });
		}
	}

	function startPick(kind: Pick['kind']) {
		(document.activeElement as HTMLElement | null)?.blur?.();
		pick = {
			kind,
			before: { query, project: filter_project, context: filter_context, saved: active_saved }
		};
		sidebar_open = true;
		cyclePick(1);
	}

	function cyclePick(step: 1 | -1) {
		if (pick === null) return;
		if (pick.kind === 'project') {
			filter_project = cycleFilter(
				projects.map((entry) => entry.tag),
				filter_project,
				step
			);
		} else if (pick.kind === 'context') {
			filter_context = cycleFilter(
				contexts.map((entry) => entry.tag),
				filter_context,
				step
			);
		} else {
			active_saved = cycleFilter(Object.keys(saved), active_saved, step);
			query = active_saved === null ? pick.before.query : saved[active_saved];
		}
	}

	function revertPick() {
		if (pick === null) return;
		({
			query,
			project: filter_project,
			context: filter_context,
			saved: active_saved
		} = pick.before);
		pick = null;
	}

	function clearFilters() {
		query = '';
		filter_project = null;
		filter_context = null;
		active_saved = null;
	}

	// ---- actions (ids match `LIST_ACTIONS`) ------------------------------------

	function step(delta: number) {
		if (pick !== null) {
			cyclePick(delta > 0 ? 1 : -1);
			return;
		}
		setCursor(moveCursor(row_ids, cursor_id, delta));
	}

	function reorder(direction: 1 | -1) {
		const at = rows.findIndex((row) => row.id === cursor_id);
		const here = rows[at];
		const there = rows[at + direction];
		if (here?.status !== 'open' || there?.status !== 'open') {
			say('Nowhere to move');
			return;
		}
		const patches = reorderPatches(rows, at, direction, sort, now);
		if (patches === null) {
			say(
				sort === 'manual'
					? 'Nowhere to move'
					: `Different ${sort === 'due' ? 'date' : 'priority or date'}: press s for manual order`
			);
			return;
		}
		void apply(
			patches.map((patch) => ({ id: patch.id, fields: { sort_key: patch.sort_key } })),
			'move'
		);
	}

	function openTag(kind: 'context' | 'project') {
		if (targets().length === 0) return;
		void openPrompt({ kind, text: '' });
	}

	function openEdit(at_start: boolean) {
		const todo = cursor_todo;
		if (todo === undefined) return;
		editAtStart = at_start;
		void openPrompt({ kind: 'edit', text: editLine(todo), id: todo.id });
	}

	function openAdd() {
		const seed = [filter_project, filter_context].filter((tag) => tag).join(' ');
		void openPrompt({ kind: 'add', text: seed === '' ? '' : `${seed} ` });
	}

	function matchStep(delta: 1 | -1) {
		if (rows.length === 0) return;
		const at = rows.findIndex((row) => row.id === cursor_id);
		setCursor(row_ids[(at + delta + rows.length) % rows.length]);
	}

	async function toggleArchiveView() {
		archive_view = !archive_view;
		endVisual();
		if (archive_view) await ensureDone();
	}

	async function toggleShowDone() {
		show_done = !show_done;
		if (show_done) await ensureDone();
	}

	const handlers: Record<string, ActionHandler> = {
		down: () => step(1),
		up: () => step(-1),
		first: () => setCursor(row_ids[0] ?? null),
		last: () => setCursor(row_ids[row_ids.length - 1] ?? null),
		half_down: () => step(Math.floor(pageSize() / 2)),
		half_up: () => step(-Math.floor(pageSize() / 2)),
		pick_commit: () => {
			pick = null;
		},
		match_next: () => matchStep(1),
		match_prev: () => matchStep(-1),
		add: openAdd,
		edit: () => openEdit(false),
		toggle: () => {
			const chosen = targets();
			const complete = chosen.some((todo) => todo.status === 'open');
			endVisual();
			void apply(
				chosen
					.filter((todo) => (complete ? todo.status === 'open' : todo.status === 'done'))
					.map((todo) => ({ id: todo.id, fields: { status: complete ? 'done' : 'open' } })),
				complete ? 'complete' : 'reopen'
			);
		},
		archive: () => {
			const chosen = targets();
			endVisual();
			void apply(
				chosen.map((todo) => ({ id: todo.id, fields: { status: 'archived' } })),
				'archive'
			);
		},
		archive_done: () => void archiveDone(),
		priority: () => {
			const chosen = targets();
			endVisual();
			void apply(
				chosen.map((todo) => ({ id: todo.id, fields: { priority: nextPriority(todo.priority) } })),
				'priority'
			);
		},
		move_down: () => reorder(1),
		move_up: () => reorder(-1),
		context: () => openTag('context'),
		project: () => openTag('project'),
		copy_line: () => {
			void copy(targets().map(rawLine));
			endVisual();
		},
		copy_body: () => {
			void copy(targets().map(bodyLine));
			endVisual();
		},
		undo: () => void doUndo(),
		visual: () => {
			if (visual !== null) endVisual();
			else if (cursor_id !== null) {
				(document.activeElement as HTMLElement | null)?.blur?.();
				visual = startVisual(cursor_id);
			}
		},
		flip: () => {
			if (visual !== null && cursor_id !== null) visual = flipRow(visual, cursor_id);
		},
		search: () => void openPrompt({ kind: 'search', text: query, before: query }),
		sort: () => {
			sort = cycleSort(sort);
			say(`Sort: ${sort}`);
		},
		save: () => void openPrompt({ kind: 'save', text: '' }),
		filter_project: () => startPick('project'),
		filter_context: () => startPick('context'),
		filter_saved: () => {
			if (Object.keys(saved).length === 0) say('No saved searches yet: search, then S');
			else startPick('saved');
		},
		show_done: () => void toggleShowDone(),
		archive_view: () => void toggleArchiveView(),
		sidebar: () => (sidebar_open = !sidebar_open),
		detail: () => (detail_open = !detail_open),
		density: () => {
			density =
				density === 'compact' ? 'comfortable' : density === 'comfortable' ? 'cozy' : 'compact';
			say(`Density: ${density}`);
		},
		numbers: () => (numbers = !numbers),
		palette: () => void openPrompt({ kind: 'command', text: '' }),
		route: () => {
			if (cursor_todo !== undefined) onroute(cursor_todo);
		},
		cancel: () => {
			if (pick !== null) revertPick();
			else if (visual !== null) endVisual();
			else if (effective_query !== '') clearFilters();
			else return false;
		}
	};

	function live(id: string): boolean {
		if (id === 'match_next' || id === 'match_prev') return query.trim() !== '';
		if (id === 'route') {
			// A routed todo may be routed again after a failed launch; the page checks.
			return cursor_todo !== undefined && cursor_todo.status === 'open';
		}
		return true;
	}

	// `front`: the list rebinds `/` and `[` over the global map while it is mounted.
	useHotkeys(() => listBindings(handlers, () => mode, live), { front: true });

	// ---- rendering helpers ------------------------------------------------------

	function prioClass(priority: number): string {
		return `p${Math.min(4, Math.max(0, priority))}`;
	}

	function rowNumber(id: string): number {
		return row_ids.indexOf(id) + 1;
	}

	function pickSidebar(kind: 'project' | 'context', tag: string) {
		if (kind === 'project') filter_project = filter_project === tag ? null : tag;
		else filter_context = filter_context === tag ? null : tag;
	}

	function pickSaved(name: string) {
		if (active_saved === name) {
			clearFilters();
		} else {
			active_saved = name;
			query = saved[name];
		}
	}

	const title_for_empty = $derived(
		archive_view
			? 'Nothing completed yet'
			: effective_query !== ''
				? 'No todo matches'
				: 'Nothing to do'
	);
	const prompt_label: Record<PromptKind, string> = {
		search: '/',
		add: 'add',
		edit: 'edit',
		context: '@',
		project: '+',
		save: 'save as',
		command: ':'
	};
</script>

<div class="tux" bind:clientWidth={width} data-density={density}>
	{#if sidebar_open}
		<aside class="side" class:is-over={narrow} aria-label="Filters">
			<section>
				<h2 class="sh">Projects</h2>
				{#each projects as entry (entry.tag)}
					<button
						type="button"
						class="si"
						class:is-on={filter_project === entry.tag}
						onclick={() => pickSidebar('project', entry.tag)}
					>
						<span class="sn">{entry.tag}</span><span class="sc">{entry.count}</span>
					</button>
				{:else}
					<p class="sd">none yet</p>
				{/each}
			</section>
			<section>
				<h2 class="sh">Contexts</h2>
				{#each contexts as entry (entry.tag)}
					<button
						type="button"
						class="si"
						class:is-on={filter_context === entry.tag}
						onclick={() => pickSidebar('context', entry.tag)}
					>
						<span class="sn">{entry.tag}</span><span class="sc">{entry.count}</span>
					</button>
				{:else}
					<p class="sd">none yet</p>
				{/each}
			</section>
			<section>
				<h2 class="sh">Saved searches</h2>
				{#each saved_counts as entry (entry.name)}
					<div class="si-row">
						<button
							type="button"
							class="si"
							class:is-on={active_saved === entry.name}
							title={entry.text}
							onclick={() => pickSaved(entry.name)}
						>
							<span class="sn">{entry.name}</span><span class="sc">{entry.count}</span>
						</button>
						<button
							type="button"
							class="si-x"
							aria-label="Remove saved search {entry.name}"
							onclick={() => deleteSaved(entry.name)}>×</button
						>
					</div>
				{:else}
					<p class="sd">/ then S saves one</p>
				{/each}
			</section>
		</aside>
	{/if}

	<div class="pane">
		<div
			class="list"
			role="listbox"
			aria-label={archive_view ? 'Completed todos' : 'Todos'}
			aria-activedescendant={cursor_id === null ? undefined : `tux-${cursor_id}`}
			tabindex="-1"
			data-tux-list
			bind:this={list_el}
			style:--row-h="{ROW_HEIGHT[density]}px"
		>
			{#each groups as group (group.key)}
				{#if group.label !== ''}
					<div class="gh">
						<span>{group.label}</span><span class="gn">{group.items.length}</span>
					</div>
				{/if}
				{#each group.items as todo (todo.id)}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<div
						id="tux-{todo.id}"
						class="trow {prioClass(todo.priority)}"
						class:is-cursor={todo.id === cursor_id}
						class:is-selected={selection_set.has(todo.id)}
						class:is-done={todo.status === 'done'}
						role="option"
						tabindex="-1"
						aria-selected={todo.id === cursor_id}
						data-row={todo.id}
						animate:flip={{ duration: dur(160) }}
						onclick={() => setCursor(todo.id)}
						ondblclick={() => openEdit(false)}
					>
						{#if numbers}<span class="ln">{rowNumber(todo.id)}</span>{/if}
						<span class="cur" aria-hidden="true">{todo.id === cursor_id ? '▸' : ''}</span>
						<button
							type="button"
							class="box"
							tabindex="-1"
							aria-label={todo.status === 'done' ? 'Reopen' : 'Complete'}
							onclick={(event) => {
								event.stopPropagation();
								setCursor(todo.id);
								handlers.toggle();
							}}>{todo.status === 'done' ? '[x]' : '[ ]'}</button
						>
						<span
							class="pr"
							title="Priority P{todo.priority} · urgency {urgency(todo.priority, todo.due_at, now)}"
							>P{todo.priority}</span
						>
						<span class="ttl">{todo.title}</span>
						<span class="tg">
							{#each todo.tags as tag (tag)}<span class={tag.startsWith('+') ? 'tp' : 'tc'}
									>{tag}</span
								>{/each}
						</span>
						{#if todo.due_at}
							<span
								class="due"
								class:late={!archive_view &&
									todo.status === 'open' &&
									dueLabel(todo.due_at, now).endsWith('overdue')}
								>due:{dueLabel(todo.due_at, now)}</span
							>
						{/if}
						{#if todo.routed_project_id}<span class="rt" title="Routed to {todo.routed_project_id}"
								>→{todo.routed_project_id}</span
							>{/if}
						{#if todo.comment_count > 0}<span class="cm">{todo.comment_count}c</span>{/if}
					</div>
				{/each}
			{:else}
				<EmptyState
					title={title_for_empty}
					description={effective_query !== ''
						? 'Esc clears the search and filters.'
						: 'n adds a todo; ? lists every key.'}
				/>
			{/each}
		</div>

		{#if prompt?.kind === 'command' && palette.length > 0}
			<ul class="pal" role="listbox" aria-label="Commands">
				{#each palette.slice(0, 9) as entry, index (entry.id)}
					<li
						class="pal-i"
						class:is-on={index === palette_index}
						role="option"
						aria-selected={index === palette_index}
					>
						<span>{entry.label}</span><kbd class="kbd">{entry.keys}</kbd>
					</li>
				{/each}
			</ul>
		{/if}

		<div class="bar" role="status">
			<span class="chip chip-{mode}" class:is-chord={chord.length > 0}>{chip}</span>
			{#if prompt !== null}
				<label class="pl">
					<span class="pk">{prompt_label[prompt.kind]}</span>
					<input
						class="pin"
						type="text"
						autocomplete="off"
						spellcheck="false"
						aria-label={prompt_label[prompt.kind]}
						placeholder={prompt.kind === 'add'
							? 'ship backups doc tomorrow p1 +beadsmith'
							: prompt.kind === 'save'
								? defaultFilterName(effective_query)
								: ''}
						bind:this={input_el}
						bind:value={prompt.text}
						oninput={onPromptInput}
						onkeydown={onPromptKey}
					/>
				</label>
			{:else}
				<span class="bi">sort:{sort}</span>
				<span class="bi">{rows.length}/{source.length}</span>
				{#if effective_query !== ''}<span class="bi bq">/{effective_query}</span>{/if}
				{#if visual !== null}<span class="bi">{selection.length} selected</span>{/if}
				{#if archive_view}<span class="bi">archive</span>{:else if show_done}<span class="bi"
						>+done</span
					>{/if}
				{#if undo_size > 0}<span class="bi">undo:{undo_size}</span>{/if}
				{#if flash}<span class="bi flash">{flash}</span>{/if}
				<span class="spacer"></span>
				<span class="bi faint">? keys · : commands</span>
			{/if}
		</div>
	</div>

	{#if detail_open}
		<aside class="detail" aria-label="Detail">
			{#if cursor_todo}
				<h2 class="sh">Line</h2>
				<pre class="raw">{rawLine(cursor_todo)}</pre>
				<dl class="meta">
					<dt>priority</dt>
					<dd>
						P{cursor_todo.priority} · urgency {urgency(
							cursor_todo.priority,
							cursor_todo.due_at,
							now
						)}
					</dd>
					<dt>due</dt>
					<dd>
						{cursor_todo.due_at
							? `${cursor_todo.due_at} (${dueLabel(cursor_todo.due_at, now)})`
							: '—'}
					</dd>
					<dt>status</dt>
					<dd>
						{cursor_todo.status}{cursor_todo.completed_at
							? ` ${cursor_todo.completed_at.slice(0, 10)}`
							: ''}
					</dd>
					<dt>routed</dt>
					<dd>{cursor_todo.routed_project_id ?? '—'}</dd>
				</dl>
				<h2 class="sh">Comments</h2>
				{#each comments as comment (comment.id)}
					<p class="cmt"><b>{comment.author}</b> {comment.text}</p>
				{:else}
					<p class="sd">none</p>
				{/each}
			{:else}
				<p class="sd">No todo selected.</p>
			{/if}
		</aside>
	{/if}
</div>

<style>
	.tux {
		display: flex;
		gap: var(--s-3);
		align-items: start;
		position: relative;
		font-family: var(--font-mono);
	}
	.side,
	.detail {
		width: 208px;
		display: flex;
		flex-direction: column;
		gap: var(--s-4);
		padding: var(--s-3);
		border: 1px solid var(--line);
		border-radius: var(--r-2);
		background: var(--s2);
		font-size: var(--t-xs);
	}
	.detail {
		width: 280px;
	}
	.side.is-over {
		position: absolute;
		z-index: 5;
		top: 0;
		left: 0;
		bottom: 0;
		overflow-y: auto;
		box-shadow: var(--shadow-tip);
		background: var(--s3);
	}
	.sh {
		margin: 0 0 var(--s-1);
		font-size: var(--t-micro);
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--tx-faint);
	}
	.si-row {
		display: flex;
		align-items: center;
	}
	.si {
		flex: 1;
		min-width: 0;
		display: flex;
		justify-content: space-between;
		gap: var(--s-2);
		padding: 2px 6px;
		background: transparent;
		border: 0;
		border-radius: var(--r-1);
		color: var(--tx);
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition: background 0.12s ease;
	}
	.si:hover {
		background: var(--s4);
	}
	.si.is-on {
		background: var(--em-wash-2);
		color: var(--tx-hi);
	}
	.sn {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sc {
		color: var(--tx-faint);
	}
	.si-x {
		padding: 0 4px;
		background: none;
		border: 0;
		color: var(--tx-faint);
		cursor: pointer;
		font: inherit;
	}
	.sd {
		margin: 0;
		color: var(--tx-faint);
	}
	.pane {
		flex: 1 1 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
		border: 1px solid var(--line);
		border-radius: var(--r-2);
		background: var(--s1);
		overflow: hidden;
	}
	.list {
		height: clamp(300px, calc(100dvh - 230px), 1000px);
		overflow-y: auto;
		outline: none;
		font-size: var(--t-sm);
	}
	.gh {
		position: sticky;
		top: 0;
		z-index: 1;
		display: flex;
		gap: var(--s-3);
		padding: 3px var(--s-3);
		background: var(--s2);
		border-bottom: 1px solid var(--line);
		font-size: var(--t-micro);
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--tx-mid);
	}
	.gn {
		color: var(--tx-faint);
	}
	.trow {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		min-height: var(--row-h);
		padding: 0 var(--s-3);
		border-left: 2px solid transparent;
		color: var(--tx);
		white-space: nowrap;
		transition:
			background 0.12s ease,
			border-color 0.12s ease,
			color 0.12s ease;
	}
	.trow:hover {
		background: var(--s2);
	}
	.trow.is-selected {
		background: var(--em-wash);
	}
	.trow.is-cursor {
		background: var(--em-wash-2);
		border-left-color: var(--em-400);
		color: var(--tx-hi);
	}
	.trow.is-done .ttl {
		text-decoration: line-through;
		color: var(--tx-faint);
	}
	.ln {
		width: 3ch;
		text-align: right;
		color: var(--tx-faint);
	}
	.cur {
		width: 1ch;
		color: var(--em-400);
	}
	.box {
		padding: 0;
		background: none;
		border: 0;
		color: var(--tx-mid);
		font: inherit;
		cursor: pointer;
	}
	.pr {
		width: 2ch;
		font-weight: 600;
		color: var(--tx-mid);
	}
	.p0 .pr {
		color: var(--danger-tx);
	}
	.p1 .pr {
		color: var(--em-300);
	}
	.p3 .pr,
	.p4 .pr {
		color: var(--tx-faint);
	}
	.ttl {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.tg {
		display: inline-flex;
		gap: var(--s-2);
		color: var(--tx-mid);
	}
	.tp {
		color: var(--em-400);
	}
	.tc {
		color: var(--tx-dim);
	}
	.due {
		color: var(--tx-mid);
	}
	.due.late {
		color: var(--danger-tx);
	}
	.rt,
	.cm {
		color: var(--tx-faint);
	}
	.pal {
		margin: 0;
		padding: var(--s-1);
		list-style: none;
		border-top: 1px solid var(--line-2);
		background: var(--s3);
		font-size: var(--t-xs);
	}
	.pal-i {
		display: flex;
		justify-content: space-between;
		padding: 2px var(--s-2);
		border-radius: var(--r-1);
	}
	.pal-i.is-on {
		background: var(--em-wash-2);
		color: var(--tx-hi);
	}
	.bar {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		min-height: 28px;
		padding: 0 var(--s-3) 0 0;
		border-top: 1px solid var(--line-2);
		background: var(--s3);
		font-size: var(--t-xs);
		color: var(--tx-mid);
	}
	.chip {
		align-self: stretch;
		display: inline-flex;
		align-items: center;
		min-width: 9ch;
		justify-content: center;
		padding: 0 var(--s-3);
		background: var(--em-600);
		color: var(--on-em);
		font-weight: 700;
		letter-spacing: 0.06em;
		transition: background 0.12s ease;
	}
	.chip-visual {
		background: var(--tx-mid);
	}
	.chip-search,
	.chip-command,
	.chip-insert,
	.chip-pick {
		background: var(--tx-hi);
		color: var(--s1);
	}
	.chip.is-chord {
		background: var(--danger);
		color: var(--on-em);
	}
	.bi.bq {
		color: var(--tx-hi);
	}
	.bi.flash {
		color: var(--em-300);
	}
	.spacer {
		flex: 1;
	}
	.faint {
		color: var(--tx-faint);
	}
	.pl {
		flex: 1;
		display: flex;
		align-items: center;
		gap: var(--s-2);
	}
	.pk {
		color: var(--tx-faint);
	}
	.pin {
		flex: 1;
		min-width: 0;
		height: 26px;
		padding: 0;
		background: transparent;
		border: 0;
		outline: none;
		color: var(--tx-hi);
		font: inherit;
	}
	.raw {
		margin: 0 0 var(--s-3);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		color: var(--tx-hi);
		font: inherit;
	}
	.meta {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 2px var(--s-3);
		margin: 0 0 var(--s-3);
	}
	.meta dt {
		color: var(--tx-faint);
	}
	.meta dd {
		margin: 0;
	}
	.cmt {
		margin: 0 0 var(--s-2);
		overflow-wrap: anywhere;
	}
	@media (max-width: 760px) {
		.tux {
			flex-wrap: wrap;
		}
		.detail {
			width: auto;
			flex: 1 1 100%;
		}
		.tg {
			display: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.trow,
		.si,
		.chip {
			transition: none;
		}
	}
</style>

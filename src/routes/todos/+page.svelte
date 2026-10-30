<script lang="ts">
	/**
	 * Admin todo agenda: a capture field parsed locally, and
	 * the open todos in 1–3 due-date columns (agenda.dev's `getColumnTodos`).
	 * Mutations are optimistic and roll back with a toast on failure.
	 */
	import { onMount, tick, untrack } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { flip } from 'svelte/animate';
	import { toast } from 'svelte-sonner';
	import EmptyState from '$lib/components/empty-state.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import TodoCapture from '$lib/components/todo-capture.svelte';
	import TodoCard from '$lib/components/todo-card.svelte';
	import TodoListView from '$lib/components/todo-list-view.svelte';
	import TodoRouteHotkey from '$lib/components/todo-route-hotkey.svelte';
	import TodoRouteDialog from '$lib/components/todo-route-dialog.svelte';
	import { api, errorMessage } from '$lib/client/api';
	import { useHotkeys } from '$lib/client/hotkeys.svelte';
	import { dur, expand, receive, send, springOut } from '$lib/client/motion';
	import type { Todo } from '$lib/server/todos/store';
	import { groupIntoColumns, type ColumnCount, type ColumnOrder } from '$lib/todos/columns';
	import { dueForColumn, placeAt } from '$lib/todos/dnd';
	import { dueLabel } from '$lib/todos/dates';
	import type { ParsedCapture } from '$lib/todos/parse';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let todos = $state<Todo[]>(untrack(() => data.todos));
	let done_todos = $state<Todo[]>([]);
	let show_done = $state(false);
	let done_loaded = $state(false);
	let refreshing = $state(false);
	let creating = $state(false);
	let now = $state(new Date());
	let board_width = $state(1000);
	let capture_el = $state<HTMLInputElement | null>(null);
	let route_target = $state<Todo | null>(null);
	let route_open = $state(false);
	let focused_id = $state<string | null>(null);

	/** Agenda or the tuxedo list; `?view=` wins, else the viewer's last choice. */
	type View = 'agenda' | 'list';
	const VIEW_KEY = 'bdui:todos-view';
	let view = $state<View>(
		untrack(() => (page.url.searchParams.get('view') === 'list' ? 'list' : 'agenda'))
	);

	/** Agenda column order: by urgency, or manual (what dragging sets). */
	const ORDER_KEY = 'bdui:todos-order';
	let order = $state<ColumnOrder>('urgency');

	onMount(() => {
		try {
			if (window.localStorage.getItem(ORDER_KEY) === 'manual') order = 'manual';
		} catch {
			/* storage unavailable */
		}
		if (page.url.searchParams.has('view')) return;
		try {
			if (window.localStorage.getItem(VIEW_KEY) === 'list') view = 'list';
		} catch {
			/* storage unavailable: stay on the agenda */
		}
	});

	function setOrder(next: ColumnOrder) {
		order = next;
		try {
			window.localStorage.setItem(ORDER_KEY, next);
		} catch {
			/* storage unavailable */
		}
	}

	function setView(next: View) {
		view = next;
		try {
			window.localStorage.setItem(VIEW_KEY, next);
		} catch {
			/* storage unavailable */
		}
		const url = new URL(page.url);
		if (next === 'list') url.searchParams.set('view', 'list');
		else url.searchParams.delete('view');
		replaceState(url, page.state);
	}

	const column_count = $derived<ColumnCount>(board_width >= 900 ? 3 : board_width >= 560 ? 2 : 1);
	const columns = $derived(groupIntoColumns(todos, column_count, now, order));
	const done_sorted = $derived(
		[...done_todos].sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))
	);

	// Keep "today" honest across midnight and long-lived tabs.
	$effect(() => {
		const tick = () => (now = new Date());
		const timer = setInterval(tick, 30_000);
		document.addEventListener('visibilitychange', tick);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', tick);
		};
	});

	useHotkeys(() => [
		{
			keys: ['n', '/'],
			label: 'Add a todo',
			group: 'General',
			when: () => view === 'agenda',
			run: () => {
				capture_el?.focus();
			}
		},
		{
			keys: ['l'],
			label: 'List view',
			group: 'General',
			when: () => view === 'agenda',
			run: () => setView('list')
		},
		{
			keys: ['alt+ArrowUp', 'alt+ArrowDown', 'alt+ArrowLeft', 'alt+ArrowRight'],
			label: 'Move the focused card: ↑↓ reorder, ←→ other column (reschedules)',
			group: 'General',
			when: () => view === 'agenda' && focused_id !== null,
			run: (event) => {
				const id = (event.target as Element | null)
					?.closest?.('[data-todo-id]')
					?.getAttribute('data-todo-id');
				if (!id || !todos.some((item) => item.id === id)) return false;
				void keyboardMove(event, id);
			}
		},
		{
			// Tab only when nothing holds focus, so keyboard navigation of the page still works.
			keys: ['Tab'],
			label: 'Switch between Agenda and List',
			group: 'General',
			run: (event) => {
				const target = event.target as Element | null;
				const idle =
					target === null ||
					target === document.body ||
					target === document.documentElement ||
					target.closest('[data-tux-list]') !== null;
				if (!idle) {
					return false;
				}
				setView(view === 'agenda' ? 'list' : 'agenda');
			}
		}
	]);

	const focused_todo = $derived(
		[...todos, ...done_todos].find(
			(item) => view === 'agenda' && item.id === focused_id && item.status === 'open'
		)
	);

	function openRoute(todo: Todo) {
		route_target = todo;
		route_open = true;
	}

	/**
	 * The `r` key: route an unrouted todo, or route again after a failed or
	 * cancelled launch (as the server allows). A live route is left alone.
	 */
	async function routeByKey(todo: Todo) {
		if (todo.routed_dispatch_id === null) {
			openRoute(todo);
			return;
		}
		try {
			const { request } = await api.todoRoute(todo.id);
			if (request === null || request.status === 'failed' || request.status === 'cancelled') {
				openRoute(todo);
			} else {
				toast('Already routed', { description: `Dispatch is ${request.status}.` });
			}
		} catch (error) {
			toast.error('Could not check the route', { description: errorMessage(error) });
		}
	}

	/** Remember which card holds focus, for the `r` key. */
	function trackFocus(event: FocusEvent) {
		const card = (event.target as Element | null)?.closest?.('[data-todo-id]');
		focused_id = card?.getAttribute('data-todo-id') ?? null;
	}

	function applyRouted(next: Todo) {
		todos = replace(todos, next);
		done_todos = replace(done_todos, next);
	}

	function replace(list: Todo[], next: Todo): Todo[] {
		return list.map((item) => (item.id === next.id ? next : item));
	}

	/** Apply `patch` locally, send it, and undo it if the server refuses. */
	async function mutate(
		todo: Todo,
		patch: Parameters<typeof api.updateTodo>[1],
		local: Partial<Todo>,
		failure: string
	) {
		const before = { open: todos, done: done_todos };
		const next = { ...todo, ...local };
		todos = replace(todos, next);
		done_todos = replace(done_todos, next);
		try {
			const { todo: saved } = await api.updateTodo(todo.id, patch);
			todos = replace(todos, saved);
			done_todos = replace(done_todos, saved);
		} catch (error) {
			todos = before.open;
			done_todos = before.done;
			toast.error(failure, { description: errorMessage(error) });
		}
	}

	async function create(parsed: ParsedCapture) {
		creating = true;
		try {
			const { todo } = await api.createTodo({
				title: parsed.title,
				priority: parsed.priority,
				due_at: parsed.due_at,
				tags: parsed.tags
			});
			todos = [...todos, todo];
		} catch (error) {
			toast.error('Could not add the todo', { description: errorMessage(error) });
			throw error;
		} finally {
			creating = false;
		}
	}

	async function complete(todo: Todo) {
		const reopening = todo.status === 'done';
		const before = { open: todos, done: done_todos };
		const next: Todo = reopening
			? { ...todo, status: 'open', completed_at: null }
			: { ...todo, status: 'done', completed_at: new Date().toISOString() };
		if (reopening) {
			done_todos = done_todos.filter((item) => item.id !== todo.id);
			todos = [...todos, next];
		} else {
			todos = todos.filter((item) => item.id !== todo.id);
			done_todos = [...done_todos, next];
		}
		try {
			const { todo: saved } = await api.updateTodo(todo.id, {
				status: reopening ? 'open' : 'done'
			});
			todos = replace(todos, saved);
			done_todos = replace(done_todos, saved);
		} catch (error) {
			todos = before.open;
			done_todos = before.done;
			toast.error(reopening ? 'Could not reopen' : 'Could not complete', {
				description: errorMessage(error)
			});
		}
	}

	function setPriority(todo: Todo, priority: number) {
		if (priority !== todo.priority) {
			void mutate(todo, { priority }, { priority }, 'Could not change priority');
		}
	}

	function reschedule(todo: Todo, due_at: string | null) {
		void mutate(todo, { due_at }, { due_at }, 'Could not reschedule');
	}

	async function archive(todo: Todo) {
		const before = { open: todos, done: done_todos };
		todos = todos.filter((item) => item.id !== todo.id);
		done_todos = done_todos.filter((item) => item.id !== todo.id);
		try {
			await api.archiveTodo(todo.id);
		} catch (error) {
			todos = before.open;
			done_todos = before.done;
			toast.error('Could not archive', { description: errorMessage(error) });
		}
	}

	function setCommentCount(todo: Todo, count: number) {
		const next = { ...todo, comment_count: count };
		todos = replace(todos, next);
		done_todos = replace(done_todos, next);
	}

	async function loadDone() {
		try {
			done_todos = (await api.todos({ status: 'done' })).todos;
			done_loaded = true;
		} catch (error) {
			toast.error('Could not load completed todos', { description: errorMessage(error) });
		}
	}

	async function ensureDone() {
		if (!done_loaded) {
			await loadDone();
		}
	}

	async function toggleDone() {
		show_done = !show_done;
		if (show_done && !done_loaded) {
			await loadDone();
		}
	}

	async function refresh() {
		refreshing = true;
		try {
			todos = (await api.todos({ status: 'open' })).todos;
			if (show_done || done_loaded) {
				await loadDone();
			}
			now = new Date();
		} catch (error) {
			toast.error('Could not refresh', { description: errorMessage(error) });
		} finally {
			refreshing = false;
		}
	}

	const meta = $derived(`${todos.length} open`);

	// ---- move: drag and drop, and Alt+arrows -------------------------------------

	let dragging_id = $state<string | null>(null);
	let drop = $state<{ column: string; index: number } | null>(null);
	let announcement = $state('');

	/** Index among a column's cards (the dragged one removed) the pointer is above. */
	function dropIndex(body: HTMLElement, y: number): number {
		const slots = [...body.querySelectorAll<HTMLElement>(':scope > .slot')].filter(
			(slot) => slot.dataset.id !== dragging_id
		);
		const at = slots.findIndex((slot) => {
			const box = slot.getBoundingClientRect();
			return y < box.top + box.height / 2;
		});
		return at === -1 ? slots.length : at;
	}

	function onDragStart(event: DragEvent, todo: Todo) {
		if ((event.target as Element).closest?.('input, textarea')) {
			event.preventDefault();
			return;
		}
		dragging_id = todo.id;
		event.dataTransfer?.setData('text/plain', todo.id);
		if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
	}

	function onDragEnd() {
		dragging_id = null;
		drop = null;
	}

	function onDragOver(event: DragEvent, column: string) {
		if (dragging_id === null) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		const index = dropIndex(event.currentTarget as HTMLElement, event.clientY);
		if (drop?.column !== column || drop.index !== index) drop = { column, index };
	}

	function onDragLeave(event: DragEvent) {
		const body = event.currentTarget as HTMLElement;
		if (!body.contains(event.relatedTarget as Node | null)) drop = null;
	}

	function onDrop(event: DragEvent, column: string) {
		if (dragging_id === null) return;
		event.preventDefault();
		const id = dragging_id;
		const index = dropIndex(event.currentTarget as HTMLElement, event.clientY);
		dragging_id = null;
		drop = null;
		void moveTodo(id, column, index);
	}

	/**
	 * Move a card to `index` among `column`'s other cards. A different column
	 * reschedules it ({@link dueForColumn}); a position change in the same
	 * column (or any drop while the order is manual) sets `sort_key`, switching
	 * the agenda to manual order first so the drop is not undone by the sort.
	 */
	async function moveTodo(id: string, column_id: string, index: number): Promise<string | null> {
		const todo = todos.find((item) => item.id === id);
		const target = columns.find((item) => item.id === column_id);
		if (todo === undefined || target === undefined) return null;
		const from = target.todos.findIndex((item) => item.id === id);
		const same = from !== -1;
		const others_ids = target.todos.filter((item) => item.id !== id).map((item) => item.id);
		const clamped = Math.max(0, Math.min(index, others_ids.length));
		const positional = same ? clamped !== from : order === 'manual';
		const due = same ? undefined : dueForColumn(target.id, todo.due_at, now);
		if (!positional && due === undefined) return null;

		let working = todos;
		if (positional && order === 'urgency') {
			// Stamp the order on screen into sort_key so switching to manual changes nothing visible.
			const stamped = columns
				.flatMap((item) => item.todos)
				.map((item, i) => ({ ...item, sort_key: i + 1 }));
			const changed = stamped.filter(
				(item) => todos.find((old) => old.id === item.id)?.sort_key !== item.sort_key
			);
			working = stamped;
			todos = stamped;
			setOrder('manual');
			toast('Manual order on', { description: 'Drag order is kept. Switch back with Order.' });
			await Promise.all(
				changed.map((item) =>
					api.updateTodo(item.id, { sort_key: item.sort_key }).catch(() => undefined)
				)
			);
		}

		const moved = working.find((item) => item.id === id) ?? todo;
		let patch: { due_at?: string | null; sort_key?: number } = {};
		const local: Partial<Todo> = {};
		if (due !== undefined) {
			patch.due_at = due;
			local.due_at = due;
		}
		const extra: { id: string; sort_key: number }[] = [];
		if (positional) {
			const others = others_ids
				.map((other) => working.find((item) => item.id === other))
				.filter((item): item is Todo => item !== undefined);
			for (const key of placeAt(moved, others, clamped)) {
				if (key.id === id) {
					patch.sort_key = key.sort_key;
					local.sort_key = key.sort_key;
				} else extra.push(key);
			}
		}
		for (const key of extra) {
			const other = working.find((item) => item.id === key.id);
			if (other) void mutate(other, { sort_key: key.sort_key }, key, 'Could not reorder');
		}
		if (Object.keys(patch).length > 0) {
			void mutate(
				moved,
				patch,
				local,
				due !== undefined ? 'Could not reschedule' : 'Could not reorder'
			);
		}
		const message =
			due !== undefined
				? `Moved to ${target.label}${due === null ? ', no date' : `, due ${dueLabel(due, now)}`}`
				: `Moved to position ${clamped + 1} in ${target.label}`;
		announcement = message;
		return message;
	}

	/** Alt+↑/↓ reorder the focused card; Alt+←/→ move it to the neighbouring column. */
	async function keyboardMove(event: KeyboardEvent, id: string) {
		const at = columns.findIndex((item) => item.todos.some((todo) => todo.id === id));
		if (at === -1) return;
		const row = columns[at].todos.findIndex((todo) => todo.id === id);
		const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown';
		let result: string | null;
		if (vertical) {
			const next = row + (event.key === 'ArrowDown' ? 1 : -1);
			if (next < 0 || next >= columns[at].todos.length) return;
			result = await moveTodo(id, columns[at].id, next);
		} else {
			const col = at + (event.key === 'ArrowRight' ? 1 : -1);
			if (col < 0 || col >= columns.length) return;
			result = await moveTodo(id, columns[col].id, columns[col].todos.length);
		}
		if (result === null) return;
		await tick();
		// A card that changes column is a new node while the old one fades out. The
		// outgoing copy is `inert` (and may come later in the DOM), so focus the live one,
		// retrying each frame until it takes focus or the move has settled.
		const deadline = performance.now() + dur(560) + 200;
		const refocus = () => {
			const live = [
				...document.querySelectorAll<HTMLElement>(`[data-todo-id="${id}"] .tc-check`)
			].find((node) => node.closest('[inert]') === null);
			if (live && document.activeElement !== live) live.focus({ preventScroll: true });
			if (document.activeElement !== live && performance.now() < deadline) {
				requestAnimationFrame(refocus);
			}
		};
		requestAnimationFrame(refocus);
	}
</script>

<svelte:head><title>Todos</title></svelte:head>

<section class="todos" onfocusin={trackFocus}>
	<PageHeader title="Todos" {meta} onrefresh={refresh} {refreshing}>
		{#snippet actions()}
			<div class="views" role="tablist" aria-label="Todo view">
				{#each ['agenda', 'list'] as const as option (option)}
					<button
						class="view"
						class:is-active={view === option}
						type="button"
						role="tab"
						aria-selected={view === option}
						onclick={() => setView(option)}
					>
						{option === 'agenda' ? 'Agenda' : 'List'}
					</button>
				{/each}
			</div>
			{#if view === 'agenda'}
				<button
					class="btn btn-sm"
					type="button"
					title="Column order: urgency, or the order you dragged cards into"
					onclick={() => setOrder(order === 'urgency' ? 'manual' : 'urgency')}
				>
					Order: {order}
				</button>
				<button
					class="btn btn-sm"
					class:is-pressed={show_done}
					type="button"
					aria-pressed={show_done}
					onclick={toggleDone}
				>
					{show_done ? 'Hide done' : 'Show done'}
				</button>
			{/if}
		{/snippet}
	</PageHeader>

	<TodoRouteHotkey
		enabled={focused_todo !== undefined}
		onroute={() => focused_todo && void routeByKey(focused_todo)}
	/>

	{#if view === 'agenda'}
		<TodoCapture {now} busy={creating} onsubmit={create} bind:input={capture_el} />
	{/if}

	<p class="sr-only" aria-live="polite">{announcement}</p>

	{#if data.error}
		<div class="banner" role="alert">Could not load todos: {data.error}</div>
	{/if}

	{#if view === 'list'}
		<TodoListView bind:todos bind:done_todos {now} onroute={routeByKey} {ensureDone} />
	{:else}
		<div class="board cols-{column_count}" bind:clientWidth={board_width}>
			{#each columns as column (column.id)}
				<div class="col" role="region" aria-label={column.label}>
					<h2 class="col-h">
						<span>{column.label}</span>
						<span class="mono-num col-n">{column.todos.length}</span>
					</h2>
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="col-body"
						class:is-drop-end={drop?.column === column.id &&
							drop.index >= column.todos.filter((item) => item.id !== dragging_id).length}
						ondragover={(event) => onDragOver(event, column.id)}
						ondragleave={onDragLeave}
						ondrop={(event) => onDrop(event, column.id)}
					>
						{#each column.todos as todo (todo.id)}
							<div
								class="slot"
								class:is-dragging={dragging_id === todo.id}
								class:drop-before={drop?.column === column.id &&
									dragging_id !== null &&
									column.todos.filter((item) => item.id !== dragging_id)[drop.index]?.id ===
										todo.id}
								data-id={todo.id}
								draggable="true"
								ondragstart={(event) => onDragStart(event, todo)}
								ondragend={onDragEnd}
								animate:flip={{ duration: dragging_id ? 0 : dur(380), easing: springOut }}
								in:receive={{ key: todo.id }}
								out:send={{ key: todo.id }}
							>
								<TodoCard
									{todo}
									{now}
									oncomplete={complete}
									onpriority={setPriority}
									onreschedule={reschedule}
									onarchive={archive}
									oncomments={setCommentCount}
									onroute={openRoute}
									onrouted={applyRouted}
								/>
							</div>
						{:else}
							<p class="col-empty">Nothing here.</p>
						{/each}
					</div>
				</div>
			{/each}
		</div>

		{#if todos.length === 0 && !data.error}
			<EmptyState
				title="Nothing on your agenda"
				description="Type above to add a todo. Try “ship backups doc tomorrow p1 +beadsmith”."
			/>
		{/if}

		{#if show_done}
			<div class="done" transition:expand>
				<h2 class="col-h">
					<span>Done</span>
					<span class="mono-num col-n">{done_sorted.length}</span>
				</h2>
				<div class="done-grid">
					{#each done_sorted as todo (todo.id)}
						<div
							class="slot"
							animate:flip={{ duration: dur(380), easing: springOut }}
							in:receive={{ key: todo.id }}
							out:send={{ key: todo.id }}
						>
							<TodoCard
								{todo}
								{now}
								oncomplete={complete}
								onpriority={setPriority}
								onreschedule={reschedule}
								onarchive={archive}
								oncomments={setCommentCount}
								onroute={openRoute}
								onrouted={applyRouted}
							/>
						</div>
					{:else}
						<p class="col-empty">Nothing completed yet.</p>
					{/each}
				</div>
			</div>
		{/if}
	{/if}
</section>

<TodoRouteDialog todo={route_target} bind:open={route_open} onrouted={applyRouted} />

<style>
	.todos {
		max-width: 1480px;
	}
	.views {
		display: inline-flex;
		border: 1px solid var(--line-2);
		border-radius: var(--r-1);
		overflow: hidden;
	}
	.view {
		height: 28px;
		padding: 0 var(--s-3);
		background: transparent;
		border: 0;
		color: var(--tx-mid);
		font: inherit;
		font-size: var(--t-xs);
		cursor: pointer;
	}
	.view.is-active {
		background: var(--s4);
		color: var(--tx-hi);
	}
	.is-pressed {
		background: var(--s4);
		color: var(--tx-hi);
	}
	.banner {
		margin-bottom: var(--s-4);
		padding: var(--s-3);
		border: 1px solid var(--danger-line);
		background: var(--danger-wash);
		color: var(--danger-tx);
		border-radius: var(--r-1);
		font-size: var(--t-sm);
	}
	.board {
		display: grid;
		gap: var(--s-4);
		align-items: start;
	}
	.board.cols-1 {
		grid-template-columns: minmax(0, 1fr);
	}
	.board.cols-2 {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
	.board.cols-3 {
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}
	.col-h {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		margin: 0 0 var(--s-3);
		padding-bottom: var(--s-2);
		border-bottom: 1px solid var(--line);
		font-size: var(--t-xs);
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--tx-mid);
	}
	.col-n {
		color: var(--tx-faint);
	}
	.col-body,
	.done-grid {
		display: flex;
		flex-direction: column;
		gap: var(--s-2);
	}
	.slot {
		position: relative;
	}
	.slot.is-dragging {
		opacity: 0.4;
	}
	.slot.drop-before::before,
	.col-body.is-drop-end::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		height: 2px;
		border-radius: 1px;
		background: var(--em-500);
		box-shadow: var(--glow-edge);
	}
	.slot.drop-before::before {
		top: calc(var(--s-2) / -2 - 1px);
	}
	.col-body {
		position: relative;
		min-height: 48px;
	}
	.col-body.is-drop-end::after {
		bottom: -2px;
	}
	.col-empty {
		margin: var(--s-2) 0;
		color: var(--tx-faint);
		font-size: var(--t-xs);
	}
	.done {
		margin-top: var(--s-6);
		overflow: hidden;
	}
	@media (min-width: 900px) {
		.done-grid {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			align-items: start;
		}
	}
</style>

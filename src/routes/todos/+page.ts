/** Open todos for the agenda; done items load on demand. */
import { api, errorMessage } from '$lib/client/api';
import type { Todo } from '$lib/server/todos/store';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	let todos: Todo[] = [];
	let error: string | null = null;
	try {
		todos = (await api.todos({ status: 'open' }, { fetch })).todos;
	} catch (thrown) {
		error = errorMessage(thrown);
	}
	return { todos, error };
};

/**
 * Where `/` lands. The project catalogue used to be the home page; it moved to
 * `/projects` so the first screen is your own work: the todo list for admins,
 * First Mate for everyone else until every account has its own todos.
 */

/** The project catalogue. */
export const PROJECTS_PATH = '/projects';

/**
 * The page `/` redirects to.
 *
 * @param role - The signed-in account's role, or undefined when signed out.
 */
export function homePath(role: string | null | undefined): string {
	return role === 'admin' ? '/todos' : '/first-mate';
}

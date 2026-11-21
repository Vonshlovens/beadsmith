/**
 * Every screenshot on the site, in one place.
 *
 * Real screenshots live in ../docs/images so the README and the docs can use
 * them too. Each is captured from the quickstart sample projects at
 * 2560×1600 in the dark theme (site/README.md says how). A shot without
 * `src` renders as a placeholder: a rough text sketch labelled as pending,
 * for a view that has no capture yet.
 */

import parade from '../../../docs/images/quickstart-parade.png';
import first_mate from '../../../docs/images/first-mate.png';
import surface from '../../../docs/images/surface.png';
import todos from '../../../docs/images/todos.png';
import board from '../../../docs/images/board.png';
import ready from '../../../docs/images/ready.png';
import activity from '../../../docs/images/activity.png';
import phone from '../../../docs/images/phone.png';

export interface Shot {
	/** Stable name; also the file name to use under docs/images. */
	id: string;
	title: string;
	caption: string;
	/** Describes the picture for screen readers. */
	alt: string;
	src?: string;
	width?: number;
	height?: number;
	/**
	 * Placeholder sketch, monospace. `{r}`, `{y}` and `{g}` become stalled,
	 * rolling and lined-up beads (one character wide each).
	 */
	sketch?: string;
	/** Placeholder shape: a desktop window or a phone. */
	frame?: 'desktop' | 'phone';
}

export const parade_shot: Shot = {
	id: 'quickstart-parade',
	title: 'Parade',
	caption:
		'The lighthouse sample project: issues grouped by state, with one open in the reading pane.',
	alt: 'Beadsmith showing the lighthouse sample project. A list groups twelve issues under Rolling, Lined up and Stalled; the issue "Alerts flap during rolling deploys" is open on the right with its metadata, parent and two comments.',
	src: parade,
	width: 2560,
	height: 1600
};

const desktop = { width: 2560, height: 1600 };

export const view_shots: Shot[] = [
	{
		id: 'first-mate',
		title: 'First Mate',
		caption:
			'First Mate, where every account lands: the chat composer over your todos and ready work. The quickstart has no model connected, so it says so.',
		alt: 'The First Mate start screen: a list of chats on the left, a composer asking "What do you want to know?" with suggested questions, a note that no model is connected yet, and panels of open todos and ready issues below.',
		src: first_mate,
		...desktop
	},
	{
		id: 'surface',
		title: 'Catalog surface',
		caption:
			'A catalog surface: stat tiles, charts and a ready list over a saved view, read as whoever opens it. Private until an admin publishes it.',
		alt: 'A dashboard called Release desk: three stat tiles (7 in flight, 14 ready, 3 projects), bar charts of issues by project and by priority, and a list of the next ready issues, with Private and Publish controls at the top.',
		src: surface,
		...desktop
	},
	{
		id: 'todos',
		title: 'Todos',
		caption: 'Todos: an admin agenda in due-date columns, each ready to route to a mission.',
		alt: 'The Todos agenda: a capture field, then columns for Today and overdue, Next 7 days and Upcoming, each with todo cards showing priority, due date and a project tag.',
		src: todos,
		...desktop
	},
	{
		id: 'board',
		title: 'Board',
		caption: 'Board: one column per status, cards sorted by priority.',
		alt: 'The lighthouse board with Open, In progress, Blocked and Deferred columns of issue cards, each with its ID, title, priority, type and labels.',
		src: board,
		...desktop
	},
	{
		id: 'ready',
		title: 'Ready',
		caption: 'Ready: every unblocked issue across all projects, one deck.',
		alt: 'The Ready deck: fourteen unblocked issues from lighthouse, pantry and trailhead in one list, sorted by priority, with project, type and age.',
		src: ready,
		...desktop
	},
	{
		id: 'activity',
		title: 'Activity log',
		caption: 'Activity log: recent changes from people and agents, newest first.',
		alt: 'The activity log: a timeline of comments, claims, label changes and new issues by people and agents across the sample projects, newest first.',
		src: activity,
		...desktop
	},
	{
		id: 'phone',
		title: 'Phone width',
		caption: 'At phone width the same parade, one column.',
		alt: 'Beadsmith on a phone: the lighthouse parade in one column, with Rolling, Lined up and Stalled groups.',
		frame: 'phone',
		src: phone,
		width: 780,
		height: 1688
	}
];

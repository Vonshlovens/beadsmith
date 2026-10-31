/**
 * Every screenshot on the site, in one place.
 *
 * Real screenshots live in ../docs/images so the README and the docs can use
 * them too. A shot without `src` renders as a placeholder: a rough text sketch
 * of the view, labelled as pending, so the page has its final shape before the
 * UI settles. To replace one, capture the view from the quickstart sample
 * projects (2560×1600, dark theme, like quickstart-parade.png), save it under
 * docs/images, then import it here and set `src`, `width` and `height`.
 */

import parade from '../../../docs/images/quickstart-parade.png';

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

export const view_shots: Shot[] = [
	{
		id: 'board',
		title: 'Board',
		caption: 'Board: one column per status, cards sorted by priority.',
		alt: 'Placeholder sketch of the board view.',
		sketch: `
lighthouse 12        parade  list  [board]

OPEN 8          IN PROGRESS 3   BLOCKED 1
┌────────────┐  ┌────────────┐  ┌────────────┐
│{g} 1     P1  │  │{y} 2.3   P0  │  │{r} 4     P1  │
│Status page │  │Alerts flap │  │Checks time │
│v1          │  │during roll…│  │out on IPv6…│
└────────────┘  └────────────┘  └────────────┘
┌────────────┐  ┌────────────┐
│{g} 2     P1  │  │{y} 3     P1  │
│Alerting    │  │Warn before │
└────────────┘  └────────────┘
┌────────────┐  ┌────────────┐
│{g} 5     P2  │  │{y} 1.3   P2  │
│Upgrade the…│  │Cache the s…│
└────────────┘  └────────────┘`
	},
	{
		id: 'ready',
		title: 'Ready',
		caption: 'Ready: every unblocked issue across all projects, one deck.',
		alt: 'Placeholder sketch of the Ready deck.',
		sketch: `
READY  unblocked issues across all projects

{g} lh-1    P1  Status page v1        lighthouse
{g} pan-4   P1  Weekly meal plan      pantry
{g} th-3    P1  Redirect the old URLs trailhead
{g} lh-2.4  P2  Choose an email pro…  lighthouse
{g} pan-6   P2  Convert between cup…  pantry
{g} lh-5    P2  Upgrade the HTTP cl…  lighthouse
{g} th-4    P2  Search with a keybo…  trailhead
{g} lh-6    P3  Write the self-host…  lighthouse
{g} pan-8   P3  Accessibility pass …  pantry
{g} lh-7    P4  Probe from several …  lighthouse`
	},
	{
		id: 'activity',
		title: 'Activity log',
		caption: 'Activity log: recent changes from people and agents, newest first.',
		alt: 'Placeholder sketch of the activity log.',
		sketch: `
ACTIVITY LOG

{y} 9m   claude-agent  status changed  pan-2
{g} 41m  alex          commented       pan-5
{y} 2h   maya          updated         lh-2.3
{g} 14h  sam           commented       lh-2.3
{r} 1d   priya         status changed  lh-4
{g} 1d   maya          commented       lh-2.3
{g} 2d   rae           created         th-3
{g} 3d   sam           created         lh-2.3
{g} 4d   lee           closed          th-1.1
{g} 6d   coding-agent  closed          lh-1.1`
	},
	{
		id: 'phone',
		title: 'Phone width',
		caption: 'At phone width the same parade, one column.',
		alt: 'Placeholder sketch of Beadsmith on a phone.',
		frame: 'phone',
		sketch: `
≡ lighthouse      /

ROLLING 3
{y} 2.3 P0 Alerts flap…
{y} 3   P1 Warn before…
{y} 1.3 P2 Cache the s…

LINED UP 8
{g} 2   P1 Alerting
{g} 1   P1 Status page…
{g} 5   P2 Upgrade the…
{g} 2.4 P2 Choose an e…

STALLED 1
{r} 4   P1 Checks time…`
	}
];

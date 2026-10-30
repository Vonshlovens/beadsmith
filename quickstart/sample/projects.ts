/**
 * Sample Beads projects for the quickstart. Fictional teams
 * and people; every time is in days relative to when Dolt first loads the
 * data, so a fresh quickstart always looks recently active.
 *
 * `scripts/quickstart-sample.ts` imports these with a real bd release and
 * writes `quickstart/initdb/*.sql`. Edit here, then regenerate.
 */

export interface SampleComment {
	by: string;
	/** Days relative to load (negative is the past). */
	at: number;
	text: string;
}

export interface SampleIssue {
	/** Id after the project prefix: `1`, `1.2`. */
	id: string;
	title: string;
	type: 'epic' | 'feature' | 'task' | 'bug' | 'chore';
	priority: 0 | 1 | 2 | 3 | 4;
	status: 'open' | 'in_progress' | 'blocked' | 'closed';
	by: string;
	created: number;
	assignee?: string;
	started?: number;
	closed?: number;
	close_reason?: string;
	parent?: string;
	blocked_by?: string[];
	labels?: string[];
	description?: string;
	design?: string;
	acceptance?: string;
	notes?: string;
	comments?: SampleComment[];
	due?: number;
	defer?: number;
	estimate_minutes?: number;
}

export interface SampleProject {
	database: string;
	prefix: string;
	issues: SampleIssue[];
}

const MIN = 1 / (24 * 60);

export const SAMPLE_PROJECTS: SampleProject[] = [
	{
		database: 'lighthouse',
		prefix: 'lh',
		issues: [
			{
				id: '1',
				title: 'Status page v1',
				type: 'epic',
				priority: 1,
				status: 'open',
				by: 'maya',
				created: -41,
				description:
					'A public page that shows whether each monitored service is up, with an incident timeline. Ships when the children below are closed.'
			},
			{
				id: '1.1',
				title: 'Render the incident timeline on the status page',
				type: 'task',
				priority: 2,
				status: 'closed',
				by: 'maya',
				created: -40,
				parent: '1',
				assignee: 'sam',
				started: -36,
				closed: -21,
				close_reason: 'Shipped in v0.3.0',
				labels: ['frontend']
			},
			{
				id: '1.2',
				title: 'Dark mode for the public status page',
				type: 'feature',
				priority: 3,
				status: 'open',
				by: 'priya',
				created: -30,
				parent: '1',
				labels: ['frontend', 'design'],
				design:
					'Follow `prefers-color-scheme`, with a toggle in the footer. Status colours keep a 4.5:1 contrast ratio in both themes.'
			},
			{
				id: '1.3',
				title: 'Cache the status JSON at the edge for 30 seconds',
				type: 'task',
				priority: 2,
				status: 'in_progress',
				by: 'maya',
				created: -9,
				parent: '1',
				assignee: 'claude-agent',
				started: -0.12,
				labels: ['backend', 'performance'],
				acceptance:
					'p95 for /status.json under 50 ms from three regions; a new incident appears within 30 seconds.',
				comments: [
					{
						by: 'claude-agent',
						at: -0.04,
						text: 'Progress:\n\n- [x] Add `Cache-Control: public, max-age=30`\n- [x] Purge on incident create\n- [ ] Measure p95 from three regions'
					}
				]
			},
			{
				id: '1.4',
				title: 'Status page shows UTC times without saying so',
				type: 'bug',
				priority: 2,
				status: 'closed',
				by: 'priya',
				created: -13,
				parent: '1',
				assignee: 'sam',
				started: -12,
				closed: -11,
				close_reason: 'Times now render in the visitor’s zone with a UTC tooltip'
			},
			{
				id: '2',
				title: 'Alerting',
				type: 'epic',
				priority: 1,
				status: 'open',
				by: 'maya',
				created: -36,
				description: 'Tell the on-call person when a check fails, without waking them for noise.'
			},
			{
				id: '2.1',
				title: 'Slack webhook alerts',
				type: 'feature',
				priority: 1,
				status: 'closed',
				by: 'maya',
				created: -35,
				parent: '2',
				assignee: 'sam',
				started: -33,
				closed: -25,
				close_reason: 'Done',
				labels: ['alerts']
			},
			{
				id: '2.2',
				title: 'Email alerts with a daily digest',
				type: 'feature',
				priority: 2,
				status: 'open',
				by: 'maya',
				created: -20,
				parent: '2',
				blocked_by: ['2.4'],
				labels: ['alerts']
			},
			{
				id: '2.3',
				title: 'Alerts flap during rolling deploys',
				type: 'bug',
				priority: 0,
				status: 'in_progress',
				by: 'sam',
				created: -3,
				parent: '2',
				assignee: 'maya',
				started: -2,
				labels: ['alerts', 'incident'],
				description:
					'During a rolling deploy the probe can hit a draining pod and fire a down alert, then a recovery alert a minute later.',
				comments: [
					{
						by: 'maya',
						at: -1.5,
						text: 'Repro: deploy `api` with 3 replicas and watch the probe log.\n\n- [x] Confirm from logs\n- [ ] Require two failed checks before alerting\n- [ ] Try it on staging'
					},
					{ by: 'sam', at: -0.6, text: 'Two consecutive failures sounds right to me.' }
				]
			},
			{
				id: '2.4',
				title: 'Choose an email provider',
				type: 'task',
				priority: 2,
				status: 'open',
				by: 'maya',
				created: -19,
				parent: '2',
				assignee: 'priya',
				labels: ['decision'],
				notes: 'Shortlist: Postmark, Amazon SES, Resend. Need EU data residency.'
			},
			{
				id: '3',
				title: 'Warn before TLS certificates expire',
				type: 'feature',
				priority: 1,
				status: 'in_progress',
				by: 'maya',
				created: -6,
				assignee: 'coding-agent',
				started: -25 * MIN,
				labels: ['checks'],
				acceptance:
					'Warn 14 days and 3 days before expiry; one alert per certificate per threshold.',
				comments: [
					{
						by: 'coding-agent',
						at: -8 * MIN,
						text: 'Reading the certificate chain from the TLS handshake; tests cover expired and self-signed certificates.'
					}
				]
			},
			{
				id: '4',
				title: 'Checks time out on IPv6-only hosts',
				type: 'bug',
				priority: 1,
				status: 'blocked',
				by: 'sam',
				created: -8,
				blocked_by: ['5'],
				labels: ['network']
			},
			{
				id: '5',
				title: 'Upgrade the HTTP client to one with Happy Eyeballs',
				type: 'chore',
				priority: 2,
				status: 'open',
				by: 'sam',
				created: -8,
				labels: ['network', 'dependencies'],
				estimate_minutes: 180
			},
			{
				id: '6',
				title: 'Write the self-hosting guide',
				type: 'task',
				priority: 3,
				status: 'open',
				by: 'priya',
				created: -15,
				defer: 7,
				labels: ['docs']
			},
			{
				id: '7',
				title: 'Probe from several regions',
				type: 'feature',
				priority: 4,
				status: 'open',
				by: 'maya',
				created: -27,
				labels: ['idea']
			},
			{
				id: '8',
				title: 'Dashboard crashes when a check has no history',
				type: 'bug',
				priority: 0,
				status: 'closed',
				by: 'priya',
				created: -3.2,
				assignee: 'sam',
				started: -3.1,
				closed: -2.9,
				close_reason: 'Fixed in v0.4.1'
			}
		]
	},
	{
		database: 'pantry',
		prefix: 'pan',
		issues: [
			{
				id: '1',
				title: 'Offline mode',
				type: 'epic',
				priority: 1,
				status: 'open',
				by: 'jo',
				created: -50,
				description: 'Recipes and the shopping list work with no signal, and sync when back online.'
			},
			{
				id: '1.1',
				title: 'Store recipes in IndexedDB',
				type: 'task',
				priority: 1,
				status: 'closed',
				by: 'jo',
				created: -49,
				parent: '1',
				assignee: 'alex',
				started: -45,
				closed: -30,
				close_reason: 'Done',
				labels: ['storage']
			},
			{
				id: '1.2',
				title: 'Resolve sync conflicts per field',
				type: 'task',
				priority: 1,
				status: 'in_progress',
				by: 'jo',
				created: -28,
				parent: '1',
				assignee: 'alex',
				started: -4,
				labels: ['sync'],
				design:
					'Last writer wins per field, using a hybrid logical clock. Deleting an item beats editing it. Lists merge by item id.'
			},
			{
				id: '1.3',
				title: 'Shopping list duplicates items after reconnecting',
				type: 'bug',
				priority: 0,
				status: 'blocked',
				by: 'kim',
				created: -2,
				parent: '1',
				blocked_by: ['1.2'],
				labels: ['sync'],
				comments: [
					{
						by: 'kim',
						at: -2,
						text: 'Steps: go offline, add “eggs”, come back online. Eggs appears twice.'
					}
				]
			},
			{
				id: '2',
				title: 'Scan barcodes to add pantry items',
				type: 'feature',
				priority: 2,
				status: 'open',
				by: 'jo',
				created: -22,
				labels: ['mobile', 'camera'],
				acceptance:
					'Scanning a supermarket barcode fills in the name and size; an unknown code opens the manual form.'
			},
			{
				id: '3',
				title: 'Convert between cups, grams and ounces',
				type: 'task',
				priority: 2,
				status: 'closed',
				by: 'jo',
				created: -20,
				assignee: 'claude-agent',
				started: -16,
				closed: -15,
				close_reason: 'Conversion table and tests merged',
				labels: ['recipes']
			},
			{
				id: '4',
				title: 'Weekly meal plan',
				type: 'feature',
				priority: 2,
				status: 'open',
				by: 'kim',
				created: -12,
				notes: 'Users asked for drag and drop between days and a “use what I have” suggestion.'
			},
			{
				id: '5',
				title: 'Search ignores accents (crème, jalapeño)',
				type: 'bug',
				priority: 2,
				status: 'in_progress',
				by: 'kim',
				created: -5,
				assignee: 'claude-agent',
				started: -1,
				labels: ['search']
			},
			{
				id: '6',
				title: 'Rotate the analytics API key',
				type: 'chore',
				priority: 1,
				status: 'open',
				by: 'alex',
				created: -4,
				assignee: 'alex',
				due: 3,
				labels: ['security']
			},
			{
				id: '7',
				title: 'Accessibility pass on the recipe view',
				type: 'task',
				priority: 3,
				status: 'open',
				by: 'jo',
				created: -18,
				labels: ['a11y']
			}
		]
	},
	{
		database: 'trailhead',
		prefix: 'th',
		issues: [
			{
				id: '1',
				title: 'Handbook v2',
				type: 'epic',
				priority: 2,
				status: 'closed',
				by: 'rae',
				created: -62,
				closed: -10,
				close_reason: 'All children shipped',
				description: 'Move the team handbook to the new docs site, keeping every old link working.'
			},
			{
				id: '1.1',
				title: 'Move pages to the new site generator',
				type: 'task',
				priority: 2,
				status: 'closed',
				by: 'rae',
				created: -60,
				parent: '1',
				assignee: 'rae',
				started: -55,
				closed: -30,
				close_reason: 'Done'
			},
			{
				id: '1.2',
				title: 'Redirect the old URLs',
				type: 'task',
				priority: 1,
				status: 'closed',
				by: 'rae',
				created: -58,
				parent: '1',
				blocked_by: ['1.1'],
				assignee: 'lee',
				started: -29,
				closed: -20,
				close_reason: '312 redirects, checked by a link crawler'
			},
			{
				id: '1.3',
				title: 'Search with a keyboard shortcut',
				type: 'task',
				priority: 3,
				status: 'closed',
				by: 'lee',
				created: -40,
				parent: '1',
				assignee: 'claude-agent',
				started: -14,
				closed: -11,
				close_reason: 'Press / to search'
			},
			{
				id: '2',
				title: 'Quarterly review of the on-call page',
				type: 'task',
				priority: 3,
				status: 'open',
				by: 'rae',
				created: -9,
				defer: 20,
				labels: ['recurring']
			},
			{
				id: '3',
				title: 'Broken image on the VPN setup page',
				type: 'bug',
				priority: 2,
				status: 'open',
				by: 'lee',
				created: -1
			}
		]
	}
];

/**
 * How the Automations page reads an automation (ADR-0019 rule 7): its
 * schedule in words, what it launches, and how each run ended. Pure
 * functions, so the list, the detail page and the dialog share one reading
 * and tests cover them without a DOM.
 */
import type {
	AutomationLaunchView,
	AutomationRunOutcome,
	AutomationTrigger
} from '#lib/automations.js';
import type { StatusKey } from '#lib/client/format.js';

const DAY_WORDS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_ABBREVIATIONS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function dayIndex(token: string): number | undefined {
	const named = DAY_ABBREVIATIONS.indexOf(token.toLowerCase());
	if (named >= 0) return named;
	if (!/^\d$/.test(token)) return undefined;
	const value = Number(token);
	return value <= 7 ? value % 7 : undefined;
}

function clock(hour: string, minute: string): string | undefined {
	if (!/^\d{1,2}$/.test(hour) || !/^\d{1,2}$/.test(minute)) return undefined;
	const h = Number(hour);
	const m = Number(minute);
	if (h > 23 || m > 59) return undefined;
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function ordinal(day: number): string {
	const tens = day % 100;
	if (tens >= 11 && tens <= 13) return `${day}th`;
	return `${day}${['th', 'st', 'nd', 'rd'][day % 10] ?? 'th'}`;
}

/** `1-5` → Weekdays; `0,6` → Weekends; `1,3` → Mondays and Wednesdays. */
function daysPhrase(field: string): string | undefined {
	const lower = field.toLowerCase();
	if (lower === '1-5' || lower === 'mon-fri') return 'Weekdays';
	if (lower === '0,6' || lower === '6,0' || lower === 'sat,sun' || lower === 'sun,sat') {
		return 'Weekends';
	}
	const days = field.split(',').map(dayIndex);
	if (days.some((day) => day === undefined)) return undefined;
	const names = days.map((day) => `${DAY_WORDS[day!]}s`);
	return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * The common schedules in words (`Daily at 02:00`, `Weekdays at 09:30`,
 * `Every 15 minutes`). Undefined for anything else: the page then shows the
 * expression itself rather than a guess.
 */
export function describeSchedule(cron: string): string | undefined {
	const fields = cron.trim().split(/\s+/);
	if (fields.length !== 5) return undefined;
	const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
	if (month !== '*') return undefined;

	if (hour === '*' && dom === '*' && dow === '*') {
		if (minute === '*') return 'Every minute';
		const step = /^\*\/(\d+)$/.exec(minute);
		if (step) return `Every ${step[1]} minutes`;
		if (/^\d{1,2}$/.test(minute) && Number(minute) <= 59) {
			return Number(minute) === 0 ? 'Hourly' : `Hourly at :${minute.padStart(2, '0')}`;
		}
		return undefined;
	}

	const hours_step = /^\*\/(\d+)$/.exec(hour);
	if (hours_step && minute === '0' && dom === '*' && dow === '*') {
		return `Every ${hours_step[1]} hours`;
	}

	const at = clock(hour, minute);
	if (at === undefined) return undefined;
	if (dom === '*' && dow === '*') return `Daily at ${at}`;
	if (dom === '*') {
		const days = daysPhrase(dow);
		return days === undefined ? undefined : `${days} at ${at}`;
	}
	if (dow === '*' && /^\d{1,2}$/.test(dom) && Number(dom) >= 1 && Number(dom) <= 31) {
		return `Monthly on the ${ordinal(Number(dom))} at ${at}`;
	}
	return undefined;
}

/** Ready-made schedules the dialog offers; any five-field cron can be typed instead. */
export const SCHEDULE_PRESETS: { cron: string; label: string }[] = [
	{ cron: '0 2 * * *', label: 'Nightly' },
	{ cron: '0 9 * * 1-5', label: 'Weekday mornings' },
	{ cron: '0 6 * * 1', label: 'Monday mornings' },
	{ cron: '0 * * * *', label: 'Hourly' }
];

const MODE_VERB: Record<string, string> = {
	build: 'Build',
	plan: 'Plan',
	run: 'Run',
	reverse: 'Reverse'
};

/**
 * What an automation launches, as a short phrase: `Build loop on bw-1`,
 * `Plan loop on the plan`, `Tackle bw-1`, `File an issue`.
 */
export function launchSummary(launch: AutomationLaunchView): string {
	const on = launch.issue_id;
	switch (launch.operation) {
		case 'loop': {
			const mode = launch.loop?.mode ?? 'build';
			const verb = MODE_VERB[mode] ?? mode;
			return on === undefined ? `${verb} loop on the whole plan` : `${verb} loop on ${on}`;
		}
		case 'tackle':
			return `Tackle ${on ?? ''}`.trim();
		case 'comment':
			return `Comment on ${on ?? ''}`.trim();
		case 'discuss':
			return `Discuss ${on ?? ''}`.trim();
		case 'file':
			return 'File an issue';
	}
}

export const AUTOMATION_OUTCOME_LABEL: Record<AutomationRunOutcome, string> = {
	firing: 'starting',
	queued: 'waiting',
	fired: 'launched',
	skipped: 'skipped',
	refused: 'refused',
	failed: 'failed'
};

/**
 * The badge colour for a run's outcome, reusing the bead badge keys: a
 * launch reads as done, a pending slot as in progress, a skip as dim, and a
 * refusal or failure as blocked. The label always says which.
 */
export function automationOutcomeKey(outcome: AutomationRunOutcome): StatusKey {
	switch (outcome) {
		case 'fired':
			return 'closed';
		case 'firing':
		case 'queued':
			return 'in_progress';
		case 'skipped':
			return 'deferred';
		case 'refused':
		case 'failed':
			return 'blocked';
	}
}

export const AUTOMATION_TRIGGER_LABEL: Record<AutomationTrigger, string> = {
	schedule: 'Scheduled',
	manual: 'Run now'
};

/**
 * A fire time in the automation's own zone, which is what its schedule
 * means: `Thu 12 Nov, 02:00`. Falls back to the viewer's zone if this
 * browser does not know the automation's.
 */
export function formatSlot(iso: string, time_zone: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return '—';
	const options: Intl.DateTimeFormatOptions = {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	};
	try {
		return date.toLocaleString(undefined, { ...options, timeZone: time_zone });
	} catch {
		return date.toLocaleString(undefined, options);
	}
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How far off a future instant is: `in 5m`, `in 3h`, `in 2d`; `due` once it has passed. */
export function relativeUntil(iso: string | undefined, now = Date.now()): string {
	if (iso === undefined) return '—';
	const at = Date.parse(iso);
	if (Number.isNaN(at)) return '—';
	const delta = at - now;
	if (delta < MINUTE) return 'due';
	if (delta < HOUR) return `in ${Math.floor(delta / MINUTE)}m`;
	if (delta < DAY) return `in ${Math.floor(delta / HOUR)}h`;
	return `in ${Math.floor(delta / DAY)}d`;
}

/** The viewer's time zone, the default for a new automation. */
export function browserTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
}

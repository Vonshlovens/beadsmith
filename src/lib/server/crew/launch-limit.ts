/**
 * Per-chat launch cap for crew tools (ADR-0020 rule 6). A First Mate chat
 * that is confused or prompt-injected (an issue's text can say anything)
 * could otherwise start missions in a loop, and each one is a sandbox and a
 * model bill. The cap is a sliding window over launches that actually
 * started: a replayed call or a refused one gives its slot back.
 *
 * It is in memory on purpose. It bounds a burst from one live chat; a
 * restart clearing it lets through at most one more window's worth, and the
 * durable record of what a chat started is the mission rows themselves.
 */
import { getEnv } from '../env.js';

export interface LaunchSlot {
	/** Give the slot back: the launch was a replay or did not happen. */
	release(): void;
}

export interface LaunchLimiter {
	/**
	 * Take a slot for one launch from `chat_id`, or say how long until one frees.
	 * @param chat_id Chat starting the mission.
	 */
	acquire(chat_id: string): { ok: true; slot: LaunchSlot } | { ok: false; retry_after_ms: number };
	readonly count: number;
	readonly window_ms: number;
}

/**
 * @param options `count` launches per `window_ms`; `now` is injectable for tests.
 */
export function createLaunchLimiter(options: {
	count: number;
	window_ms: number;
	now?: () => number;
}): LaunchLimiter {
	const now = options.now ?? Date.now;
	/** Chat id → start times of its launches inside the window, oldest first. */
	const launches = new Map<string, number[]>();

	return {
		count: options.count,
		window_ms: options.window_ms,
		acquire(chat_id) {
			const current = now();
			const recent = (launches.get(chat_id) ?? []).filter((at) => current - at < options.window_ms);
			if (recent.length >= options.count) {
				launches.set(chat_id, recent);
				return { ok: false, retry_after_ms: recent[0] + options.window_ms - current };
			}
			recent.push(current);
			launches.set(chat_id, recent);
			let released = false;
			return {
				ok: true,
				slot: {
					release() {
						if (released) return;
						released = true;
						const list = launches.get(chat_id);
						const index = list?.indexOf(current) ?? -1;
						if (list !== undefined && index >= 0) list.splice(index, 1);
						if (list !== undefined && list.length === 0) launches.delete(chat_id);
					}
				}
			};
		}
	};
}

let default_limiter: LaunchLimiter | undefined;

/** The production limiter, sized by `BDX_CREW_LAUNCH_LIMIT` and `BDX_CREW_LAUNCH_WINDOW_MINUTES`. */
export function getLaunchLimiter(): LaunchLimiter {
	if (default_limiter === undefined) {
		const { count, window_minutes } = getEnv().crew_launch_limit;
		default_limiter = createLaunchLimiter({ count, window_ms: window_minutes * 60_000 });
	}
	return default_limiter;
}

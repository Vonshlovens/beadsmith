/**
 * The one error grown things throw for a refusal (ADR-0025). Kept apart from
 * the store and the specs, with no imports, so `security.ts` can map it to an
 * HTTP response without pulling validation into an import cycle.
 */
export type GrownErrorCode = 'bad_request' | 'forbidden' | 'not_found' | 'conflict';

/**
 * A request the grown layer refused: a limit, an invalid spec, a missing
 * thing or project, or a viewer without the right. The message says what to
 * do, for a person or the model, and is safe to show.
 */
export class GrownError extends Error {
	constructor(
		readonly code: GrownErrorCode,
		message: string
	) {
		super(message);
		this.name = 'GrownError';
	}
}

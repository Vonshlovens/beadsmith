/**
 * Errors from the hc client. `kind` is hc's stable `data.kind` for errors
 * the core reported (`not_found`, `blocked`, `finished`, `unavailable`, ...),
 * or one of the client's own:
 *
 * - `invalid_params`: refused before sending (also hc's kind for the same).
 * - `unsupported_generation`: the core speaks another protocol generation.
 * - `protocol`: the core sent something this client can't read.
 * - `timeout`: no reply in time; the request may still have run.
 * - `disconnected`: the connection ended with the request outstanding.
 */
export class HcError extends Error {
	name = 'HcError';
	readonly kind: string;
	/** JSON-RPC error code, when the core sent one. */
	readonly code: number | null;
	/** hc's hint for a person, when it sent one. */
	readonly hint: string | null;

	constructor(message: string, options: { kind: string; code?: number; hint?: string | null }) {
		super(message);
		this.kind = options.kind;
		this.code = options.code ?? null;
		this.hint = options.hint ?? null;
	}
}

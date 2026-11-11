/**
 * herdr-core's framed mode, byte for byte (protocol generation 1).
 *
 * After `hello` with `framed: true` every message on the connection is
 * `[channel u32 LE][kind u8][len u32 LE][payload]`. Channel 0 carries one
 * JSON-RPC message per DATA frame; attach and event streams get channels of
 * their own. The format is documented in herdr-core's `schema/README.md`
 * (github.com/herdrdev/herdr-core). The transports Beadsmith uses (SSH, the
 * E2B process channel) split and merge writes freely, so both decoders here
 * accept bytes in any chunking.
 *
 * Plain JavaScript only (no Node or SvelteKit imports): the same module runs
 * in the app and in the forge runner, which Node runs with type stripping.
 */

export const FRAME_HEADER = 9;
/** hc refuses larger frames; so do we, rather than buffer without bound. */
export const MAX_FRAME_PAYLOAD = 16 << 20;
/** Credit a stream starts with before the viewer acknowledges anything. */
export const STREAM_WINDOW = 256 * 1024;

export const DATA = 0;
export const CREDIT = 1;
export const CLOSE = 2;
export const RESIZE = 3;
export const FOCUS = 4;
export const FACTS = 5;
export const AUTOMATIC_INPUT = 6;

export interface Frame {
	channel: number;
	kind: number;
	payload: Uint8Array;
}

/** The framing broke: the connection can't be trusted to carry more. */
export class FrameError extends Error {
	name = 'FrameError';
}

export function encodeFrame(channel: number, kind: number, payload: Uint8Array): Uint8Array {
	if (!Number.isInteger(channel) || channel < 0 || channel > 0xffffffff) {
		throw new FrameError(`invalid channel ${channel}`);
	}
	if (!Number.isInteger(kind) || kind < 0 || kind > 0xff) {
		throw new FrameError(`invalid frame kind ${kind}`);
	}
	if (payload.length > MAX_FRAME_PAYLOAD) {
		throw new FrameError(`frame of ${payload.length} bytes exceeds ${MAX_FRAME_PAYLOAD}`);
	}
	const out = new Uint8Array(FRAME_HEADER + payload.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, channel, true);
	view.setUint8(4, kind);
	view.setUint32(5, payload.length, true);
	out.set(payload, FRAME_HEADER);
	return out;
}

export function encodeU32(n: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, n, true);
	return out;
}

export function decodeU32(payload: Uint8Array): number {
	if (payload.length !== 4) throw new FrameError(`expected 4 bytes, got ${payload.length}`);
	return new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true);
}

export function encodeSize(cols: number, rows: number): Uint8Array {
	const out = new Uint8Array(4);
	const view = new DataView(out.buffer);
	view.setUint16(0, cols, true);
	view.setUint16(2, rows, true);
	return out;
}

export function decodeSize(payload: Uint8Array): { cols: number; rows: number } {
	if (payload.length !== 4) throw new FrameError(`expected 4 bytes, got ${payload.length}`);
	const view = new DataView(payload.buffer, payload.byteOffset, 4);
	return { cols: view.getUint16(0, true), rows: view.getUint16(2, true) };
}

/** Joins byte chunks and cuts them into whole frames. */
export class FrameDecoder {
	#buffer: Uint8Array = new Uint8Array(0);

	/** Frames completed by these bytes, in order. Throws FrameError on an oversized frame. */
	push(bytes: Uint8Array): Frame[] {
		this.#buffer = concat(this.#buffer, bytes);
		const frames: Frame[] = [];
		let at = 0;
		while (this.#buffer.length - at >= FRAME_HEADER) {
			const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset + at, FRAME_HEADER);
			const channel = view.getUint32(0, true);
			const kind = view.getUint8(4);
			const length = view.getUint32(5, true);
			if (length > MAX_FRAME_PAYLOAD) {
				throw new FrameError(`frame of ${length} bytes exceeds ${MAX_FRAME_PAYLOAD}`);
			}
			if (this.#buffer.length - at - FRAME_HEADER < length) break;
			const start = at + FRAME_HEADER;
			// A copy, so a listener can keep the payload after the buffer moves on.
			frames.push({ channel, kind, payload: this.#buffer.slice(start, start + length) });
			at = start + length;
		}
		this.#buffer = this.#buffer.slice(at);
		return frames;
	}

	/** Bytes held waiting for the rest of a frame. */
	get pending(): number {
		return this.#buffer.length;
	}
}

/**
 * Joins byte chunks into UTF-8 lines (without the newline). Used for the
 * plain-mode `hello` reply and for event channels, whose JSON lines hc cuts
 * into frames without regard for line or character boundaries.
 */
export class LineDecoder {
	#decoder = new TextDecoder('utf-8', { fatal: false });
	#partial = '';
	readonly #max: number;

	constructor(max_line = MAX_FRAME_PAYLOAD) {
		this.#max = max_line;
	}

	/** Whole lines completed by these bytes. Throws FrameError on an over-long line. */
	push(bytes: Uint8Array): string[] {
		const text = this.#partial + this.#decoder.decode(bytes, { stream: true });
		const parts = text.split('\n');
		this.#partial = parts.pop() ?? '';
		if (this.#partial.length > this.#max) {
			throw new FrameError(`line longer than ${this.#max} characters`);
		}
		return parts.filter((line) => line.length > 0);
	}
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	if (a.length === 0) return b;
	if (b.length === 0) return a;
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

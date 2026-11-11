import { describe, expect, it } from 'vitest';
import {
	CLOSE,
	DATA,
	FRAME_HEADER,
	FrameDecoder,
	FrameError,
	LineDecoder,
	MAX_FRAME_PAYLOAD,
	RESIZE,
	decodeSize,
	decodeU32,
	encodeFrame,
	encodeSize,
	encodeU32
} from './frames';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('encodeFrame', () => {
	it('writes channel and length little-endian around the kind', () => {
		const frame = encodeFrame(0x01020304, CLOSE, bytes('hi'));
		expect([...frame]).toEqual([4, 3, 2, 1, CLOSE, 2, 0, 0, 0, 104, 105]);
	});

	it('refuses an oversized payload, a bad channel and a bad kind', () => {
		expect(() => encodeFrame(0, DATA, new Uint8Array(MAX_FRAME_PAYLOAD + 1))).toThrow(FrameError);
		expect(() => encodeFrame(-1, DATA, new Uint8Array())).toThrow(FrameError);
		expect(() => encodeFrame(2 ** 32, DATA, new Uint8Array())).toThrow(FrameError);
		expect(() => encodeFrame(0, 256, new Uint8Array())).toThrow(FrameError);
	});
});

describe('FrameDecoder', () => {
	const stream = new Uint8Array([
		...encodeFrame(0, DATA, bytes('{"id":1}')),
		...encodeFrame(7, RESIZE, encodeSize(120, 40)),
		...encodeFrame(7, DATA, new Uint8Array()),
		...encodeFrame(9, DATA, bytes('tail'))
	]);

	it('reads frames merged into one chunk', () => {
		const frames = new FrameDecoder().push(stream);
		expect(frames.map((f) => [f.channel, f.kind, f.payload.length])).toEqual([
			[0, DATA, 8],
			[7, RESIZE, 4],
			[7, DATA, 0],
			[9, DATA, 4]
		]);
		expect(decodeSize(frames[1].payload)).toEqual({ cols: 120, rows: 40 });
	});

	it('reads the same frames from any split, down to one byte at a time', () => {
		for (const size of [1, 2, 5, FRAME_HEADER, FRAME_HEADER + 1, 13]) {
			const decoder = new FrameDecoder();
			const frames = [];
			for (let at = 0; at < stream.length; at += size) {
				frames.push(...decoder.push(stream.subarray(at, at + size)));
			}
			expect(frames.map((f) => new TextDecoder().decode(f.payload))).toEqual([
				'{"id":1}',
				new TextDecoder().decode(encodeSize(120, 40)),
				'',
				'tail'
			]);
			expect(decoder.pending).toBe(0);
		}
	});

	it('keeps a partial frame until the rest arrives', () => {
		const decoder = new FrameDecoder();
		expect(decoder.push(stream.subarray(0, 12))).toEqual([]);
		expect(decoder.pending).toBe(12);
	});

	it('refuses a header announcing more than hc ever sends', () => {
		const header = new Uint8Array(FRAME_HEADER);
		new DataView(header.buffer).setUint32(5, MAX_FRAME_PAYLOAD + 1, true);
		expect(() => new FrameDecoder().push(header)).toThrow(FrameError);
	});

	it('hands out payloads that survive later pushes', () => {
		const decoder = new FrameDecoder();
		const [first] = decoder.push(encodeFrame(1, DATA, bytes('keep')));
		decoder.push(encodeFrame(1, DATA, bytes('next')));
		expect(new TextDecoder().decode(first.payload)).toBe('keep');
	});
});

describe('u32 and size payloads', () => {
	it('round-trip', () => {
		expect(decodeU32(encodeU32(256 * 1024))).toBe(256 * 1024);
		expect(decodeSize(encodeSize(1, 65535))).toEqual({ cols: 1, rows: 65535 });
	});

	it('refuse the wrong length', () => {
		expect(() => decodeU32(new Uint8Array(3))).toThrow(FrameError);
		expect(() => decodeSize(new Uint8Array(5))).toThrow(FrameError);
	});
});

describe('LineDecoder', () => {
	it('joins lines cut anywhere, including inside a multi-byte character', () => {
		const text = bytes('{"a":"é"}\n{"b":"✓"}\npartial');
		const decoder = new LineDecoder();
		const lines: string[] = [];
		for (let at = 0; at < text.length; at += 1)
			lines.push(...decoder.push(text.subarray(at, at + 1)));
		expect(lines).toEqual(['{"a":"é"}', '{"b":"✓"}']);
		expect(decoder.push(bytes('\n'))).toEqual(['partial']);
	});

	it('skips empty lines and refuses one that never ends', () => {
		expect(new LineDecoder().push(bytes('\n\nx\n'))).toEqual(['x']);
		expect(() => new LineDecoder(4).push(bytes('12345'))).toThrow(FrameError);
	});
});

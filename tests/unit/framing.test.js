import { describe, it, expect } from 'vitest';
import { encode, Decoder, LineSplitter, HOST_TO_CHROME_MAX } from '../../host/framing.js';

describe('F2 native framing', () => {
  it('round-trips messages with a 4-byte length prefix', () => {
    const buf = encode({ id: 1, cmd: 'ping', text: 'héllo ✓' });
    expect(buf.readUInt32LE(0)).toBe(buf.length - 4);
    expect(new Decoder().push(buf)).toEqual([{ id: 1, cmd: 'ping', text: 'héllo ✓' }]);
  });
  it('handles messages split across chunks and several per chunk', () => {
    const all = Buffer.concat([encode({ a: 1 }), encode({ b: 2 }), encode({ c: 3 })]);
    const d = new Decoder();
    const got = [];
    for (let i = 0; i < all.length; i += 3) got.push(...d.push(all.subarray(i, i + 3)));
    expect(got).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });
  it('B4 refuses host→Chrome messages over 1 MB', () => {
    expect(() => encode({ x: 'y'.repeat(HOST_TO_CHROME_MAX) })).toThrow(/limit/);
    expect(() => encode({ x: 'y'.repeat(HOST_TO_CHROME_MAX - 100) })).not.toThrow();
  });
  it('decodes large Chrome→host messages (e.g. screenshots)', () => {
    const big = { image: 'z'.repeat(5 * 1024 * 1024) };
    const body = Buffer.from(JSON.stringify(big));
    const head = Buffer.alloc(4); head.writeUInt32LE(body.length);
    expect(new Decoder().push(Buffer.concat([head, body]))[0].image.length).toBe(big.image.length);
  });
  it('a malformed NDJSON line is skipped without losing its neighbours', () => {
    const errs = [];
    const s = new LineSplitter({ onError: (e) => errs.push(e) });
    expect(s.push(Buffer.from('{"a":1}\nnot json\n{"b":2}\n'))).toEqual([{ a: 1 }, { b: 2 }]);
    expect(errs).toHaveLength(1);
  });
  it('caps an endless line', () => {
    const errs = [];
    const s = new LineSplitter({ maxBytes: 10, onError: (e) => errs.push(e) });
    s.push(Buffer.from('x'.repeat(50)));
    expect(errs[0].message).toMatch(/cap/);
    expect(s.push(Buffer.from('{"ok":1}\n'))).toEqual([{ ok: 1 }]);
  });
  it('splits NDJSON across chunk boundaries', () => {
    const s = new LineSplitter();
    expect(s.push(Buffer.from('{"a":1}\n{"b"'))).toEqual([{ a: 1 }]);
    expect(s.push(Buffer.from(':2}\n'))).toEqual([{ b: 2 }]);
  });
});

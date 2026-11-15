// Chrome native-messaging framing: 32-bit length (native byte order) + UTF-8 JSON.
import os from 'node:os';

export const HOST_TO_CHROME_MAX = 1024 * 1024; // Chrome rejects larger host→browser messages
const LE = os.endianness() === 'LE';

export function encode(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  if (body.length > HOST_TO_CHROME_MAX) {
    throw new RangeError(`native message is ${body.length} bytes; Chrome limit is ${HOST_TO_CHROME_MAX}`);
  }
  const head = Buffer.alloc(4);
  if (LE) head.writeUInt32LE(body.length, 0); else head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

// Incremental decoder: feed arbitrary chunks, get complete messages back.
export class Decoder {
  constructor(maxBytes = 64 * 1024 * 1024) {
    this.buf = Buffer.alloc(0);
    this.max = maxBytes;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    while (this.buf.length >= 4) {
      const len = LE ? this.buf.readUInt32LE(0) : this.buf.readUInt32BE(0);
      if (len > this.max) throw new RangeError(`incoming native message too large: ${len}`);
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len).toString('utf8');
      this.buf = this.buf.subarray(4 + len);
      out.push(JSON.parse(body));
    }
    return out;
  }
}

// Newline-delimited JSON splitter for the unix-socket side.
// A bad line is reported via onError and skipped; it never takes the other lines down with it.
export class LineSplitter {
  constructor({ maxBytes = 64 * 1024 * 1024, onError = () => {} } = {}) {
    this.rest = '';
    this.max = maxBytes;
    this.onError = onError;
  }
  push(chunk) {
    this.rest += chunk.toString('utf8');
    const parts = this.rest.split('\n');
    this.rest = parts.pop();
    if (this.rest.length > this.max) {
      this.rest = '';
      this.onError(new RangeError('line exceeds size cap; dropped'));
    }
    const out = [];
    for (const l of parts) {
      if (!l.trim()) continue;
      try { out.push(JSON.parse(l)); } catch (e) { this.onError(e); }
    }
    return out;
  }
}

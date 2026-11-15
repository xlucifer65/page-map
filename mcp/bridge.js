// Unix-socket listener the native host connects to. Sends commands, matches replies by id.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { LineSplitter } from '../host/framing.js';

function probe(sockPath) {
  return new Promise((resolve) => {
    const s = net.createConnection(sockPath);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

export class Bridge {
  constructor(sockPath, { log = () => {} } = {}) {
    this.sockPath = sockPath;
    this.log = log;
    this.conn = null;
    this.pending = new Map();
    this.nextId = 1;
    this.server = null;
    this.connectedAt = null;
  }

  async listen() {
    const dir = path.dirname(this.sockPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(path.dirname(dir), 0o700);
    if (fs.existsSync(this.sockPath)) {
      if (await probe(this.sockPath)) {
        throw new Error(`another page-map server is already running on ${this.sockPath}`);
      }
      fs.unlinkSync(this.sockPath); // stale socket from a crashed run
    }
    this.server = net.createServer((c) => this.#accept(c));
    const old = process.umask(0o177); // socket created as 0600
    try {
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.sockPath, resolve);
      });
    } finally {
      process.umask(old);
    }
    fs.chmodSync(this.sockPath, 0o600);
  }

  #accept(c) {
    // First host keeps the server. A second one (another Chrome profile/browser) is refused
    // instead of evicting, which would make the two flap. A reloaded extension's old host
    // exits (Chrome closes its stdin), so the new one gets in on its next retry.
    if (this.conn && !this.conn.destroyed) {
      c.end(JSON.stringify({ type: 'rejected', reason: 'another browser is already connected to this page-map server' }) + '\n');
      this.log('refused a second extension host');
      return;
    }
    this.conn = c;
    this.connectedAt = Date.now();
    const lines = new LineSplitter({ onError: (e) => this.log('bad line from host', e.message) });
    c.on('data', (chunk) => {
      for (const m of lines.push(chunk)) this.#onMessage(m);
    });
    c.on('close', () => {
      if (this.conn === c) {
        this.conn = null;
        for (const [, p] of this.pending) p.reject(new Error('extension disconnected'));
        this.pending.clear();
      }
    });
    c.on('error', () => {});
    this.log('extension host connected');
  }

  #onMessage(m) {
    if (m && m.type === 'hello') return;
    const p = m && this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    p.resolve(m);
  }

  get connected() { return !!this.conn; }

  request(cmd, args = {}, timeoutMs = 20000) {
    if (!this.conn) {
      return Promise.reject(new Error('Chrome extension not connected. Is Chrome open with the Page-Map extension installed, and was `npm run install-host` run?'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out after ${timeoutMs} ms waiting for "${cmd}"`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.conn.write(JSON.stringify({ id, cmd, args }) + '\n');
    });
  }

  // Wait up to ms for the extension to connect (used right after startup).
  async waitForConnection(ms) {
    const end = Date.now() + ms;
    while (!this.conn && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    return this.connected;
  }

  close() {
    if (this.conn) this.conn.destroy();
    if (this.server) this.server.close();
    try { fs.unlinkSync(this.sockPath); } catch (_) {}
  }
}

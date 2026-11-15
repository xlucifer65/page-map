// Native messaging host. Chrome starts this process; it relays between Chrome
// (stdin/stdout, length-prefixed JSON) and every running Page-Map MCP server —
// one unix socket per agent session in ~/.page-map/sessions/. Request ids are
// rewritten so replies go back to the session that asked, letting several agents
// drive different tabs of the same Chrome in parallel.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { encode, Decoder, LineSplitter } from './framing.js';
import { sessionsDir } from './paths.js';

const log = (...a) => process.stderr.write(`[page-map host] ${a.join(' ')}\n`);
const decoder = new Decoder();
const sessions = new Map(); // socket path -> { sock, rejectedUntil }
const routes = new Map();   // host id -> { sock, id }
let nextId = 1;

function toChrome(obj, sock) {
  try {
    process.stdout.write(encode(obj));
  } catch (e) {
    // Too big for Chrome: answer the session directly instead of forwarding.
    const r = routes.get(obj.id);
    routes.delete(obj.id);
    if (r) r.sock.write(JSON.stringify({ id: r.id, ok: false, error: String(e.message) }) + '\n');
    else if (sock) sock.write(JSON.stringify({ ok: false, error: String(e.message) }) + '\n');
  }
}

function connect(file) {
  const entry = { sock: null, rejectedUntil: 0 };
  sessions.set(file, entry);
  const s = net.createConnection(file);
  const lines = new LineSplitter({ onError: (e) => log('bad line from server', e.message) });
  s.on('connect', () => {
    entry.sock = s;
    s.write(JSON.stringify({ type: 'hello', from: 'host', pid: process.pid }) + '\n');
  });
  s.on('data', (chunk) => {
    for (const m of lines.push(chunk)) {
      if (m && m.type === 'rejected') { entry.rejectedUntil = Date.now() + 15000; log('session refused:', m.reason); continue; }
      if (!m || m.id === undefined) continue;
      const hid = nextId++;
      routes.set(hid, { sock: s, id: m.id });
      toChrome({ ...m, id: hid }, s);
    }
  });
  const drop = (err) => {
    for (const [hid, r] of routes) if (r.sock === s) routes.delete(hid);
    if (err && err.code === 'ECONNREFUSED') { try { fs.unlinkSync(file); } catch (_) {} } // server is gone
    // Keep a rejected entry until its back-off expires so the scan doesn't hammer it.
    if (entry.rejectedUntil > Date.now()) entry.sock = null; else sessions.delete(file);
  };
  s.on('error', drop);
  s.on('close', () => drop());
}

function scan() {
  let files = [];
  try { files = fs.readdirSync(sessionsDir()).filter((f) => f.endsWith('.sock')).map((f) => path.join(sessionsDir(), f)); } catch (_) {}
  for (const f of files) {
    const e = sessions.get(f);
    if (!e) connect(f);
    else if (!e.sock && e.rejectedUntil && e.rejectedUntil <= Date.now()) { sessions.delete(f); connect(f); }
  }
}

process.stdin.on('data', (chunk) => {
  let msgs;
  try { msgs = decoder.push(chunk); } catch (e) { log('bad frame', e.message); process.exit(1); }
  for (const m of msgs) {
    const r = routes.get(m.id);
    if (!r) continue;
    routes.delete(m.id);
    r.sock.write(JSON.stringify({ ...m, id: r.id }) + '\n');
  }
});
// Chrome closed the port (extension reloaded / browser quit).
process.stdin.on('end', () => process.exit(0));

scan();
setInterval(scan, 500);

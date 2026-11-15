#!/usr/bin/env node
// Checks the live Chrome extension is the current version: connects, then exercises the newest features.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const c = new Client({ name: 'verify', version: '1' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'mcp/server.js')], stderr: 'ignore' }));
const t = (r) => r.content.map((x) => x.text || '').join('');
const call = (name, args = {}) => c.callTool({ name, arguments: args });
let ok = false;
for (let i = 0; i < 30 && !ok; i++) { ok = /extension connected/.test(t(await call('stats'))); if (!ok) await new Promise((r) => setTimeout(r, 500)); }
console.log(ok ? '✓ extension connected (new multi-session host)' : '✗ extension NOT connected');
if (ok) {
  const nav = await call('navigate', { url: 'https://example.com/', new_tab: true });
  console.log(nav.isError ? '✗ navigate: ' + t(nav) : '✓ navigate returns outline + text preview: ' + /--- text preview ---/.test(t(nav)));
  const b = await call('batch', { steps: [{ action: 'scroll', direction: 'down' }] });
  console.log(/unknown command/.test(t(b)) ? '✗ old extension code (no batch)' : '✓ batch supported (new extension code)');
  const rt = await call('read_text');
  console.log(/Example Domain/.test(t(rt)) ? '✓ read_text works' : '✗ read_text: ' + t(rt).slice(0, 200));
}
await c.close();
process.exit(ok ? 0 : 1);

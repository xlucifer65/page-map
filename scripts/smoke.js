#!/usr/bin/env node
// Quick check that the real Chrome extension is reachable: spawns the MCP server and calls stats + list_tabs.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'mcp/server.js')], stderr: 'inherit' }));
const text = (r) => r.content.map((c) => c.text).join('');
let ok = false;
for (let i = 0; i < 20 && !ok; i++) {
  ok = /extension connected/.test(text(await client.callTool({ name: 'stats', arguments: {} })));
  if (!ok) await new Promise((r) => setTimeout(r, 500));
}
console.log(ok ? 'extension connected ✓' : 'extension NOT connected ✗');
if (ok) console.log(text(await client.callTool({ name: 'list_tabs', arguments: {} })).split('\n').slice(0, 6).join('\n'));
await client.close();
process.exit(ok ? 0 : 1);

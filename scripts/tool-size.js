#!/usr/bin/env node
// Size of the tool definitions an agent receives (re-sent every turn).
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const mode of ['structure', 'vision']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmts-'));
  const c = new Client({ name: 'size', version: '1' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'mcp/server.js')], env: { ...process.env, PAGEMAP_DIR: dir, PAGEMAP_MODE: mode }, stderr: 'ignore' }));
  const { tools } = await c.listTools();
  const chars = JSON.stringify(tools).length;
  console.log(`${mode}: ${tools.length} tools, ${chars} chars ≈ ${Math.ceil(chars / 4)} tokens per turn`);
  await c.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

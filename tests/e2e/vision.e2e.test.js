// F4: real Chromium + real extension + real native host + real MCP server + MCP client.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { install } from '../../scripts/install-host.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmv-'));
const rt = path.join(dir, 'rt');
const profile = path.join(dir, 'profile');
let server, base, ctx, client, sw, page;

const textOf = (r) => r.content.map((c) => c.text || '').join('');
const call = async (name, args = {}) => client.callTool({ name, arguments: args });
const refFor = (text, label) => {
  const m = text.match(new RegExp(`^([a-z]+\\d+) \\S+ "${label}"`, 'm'));
  if (!m) throw new Error(`no "${label}" in:\n${text}`);
  return m[1];
};

beforeAll(async () => {
  // Static fixture server.
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/redirect')) { // → same server under another hostname (for the blocklist test)
      res.writeHead(302, { location: `http://localhost:${server.address().port}/page2.html` });
      return res.end();
    }
    const f = path.join(root, 'tests/fixtures', path.basename(req.url.split('?')[0]) || 'shop.html');
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // Chromium reads user-level native hosts from <user-data-dir>/NativeMessagingHosts.
  install({ hostsDir: path.join(profile, 'NativeMessagingHosts'), runtimeDir: rt });

  client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'mcp/server.js')],
    env: { ...process.env, PAGEMAP_DIR: rt, PAGEMAP_MODE: 'vision' },
    stderr: 'pipe',
  }));

  const ext = path.join(root, 'extension');
  ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(`${base}/shop.html`);

  // Wait for extension → host → server to connect.
  for (let i = 0; i < 100; i++) {
    const r = await call('navigate', { url: `${base}/shop.html` });
    if (!r.isError) break;
    await new Promise((res) => setTimeout(res, 200));
  }
}, 90000);

afterAll(async () => {
  await ctx?.close();
  await client?.close();
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('vision mode (screenshot baseline)', () => {
  it('exposes only pixel tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['click_xy', 'navigate', 'screenshot', 'scroll', 'type_text']);
  });
  it('screenshot is CSS-pixel sized; click_xy and type_text drive the page; no structure leaks', async () => {
    const shot = await call('screenshot');
    expect(shot.content[0].type).toBe('image');
    const vp = page.viewportSize();
    const buf = Buffer.from(shot.content[0].data, 'base64');
    let i = 2, w, h;
    while (i < buf.length) { if (buf[i] === 0xff && buf[i + 1] >= 0xc0 && buf[i + 1] <= 0xc2) { h = buf.readUInt16BE(i + 5); w = buf.readUInt16BE(i + 7); break; } i += buf[i] === 0xff ? 2 + buf.readUInt16BE(i + 2) : 1; }
    expect([w, h]).toEqual([vp.width, vp.height]);

    const b = await page.locator('#add').boundingBox();
    const r = await call('click_xy', { x: b.x + b.width / 2, y: b.y + b.height / 2 });
    expect(textOf(r)).toMatch(/\nclicked at/);
    expect(await page.locator('#cart li').count()).toBe(1);

    const q = await page.locator('#q').boundingBox();
    await call('click_xy', { x: q.x + 5, y: q.y + q.height / 2 });
    const t = await call('type_text', { text: 'knives', enter: true });
    expect(textOf(t)).not.toMatch(/button|textbox/);
    expect(await page.locator('#result').textContent()).toContain('Result for knives');
    const s = await call('scroll', { direction: 'down' });
    expect(textOf(s)).not.toMatch(/[+~-] [a-z]+\d+ /);
  });
});

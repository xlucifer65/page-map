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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pme-'));
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
    env: { ...process.env, PAGEMAP_DIR: rt },
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
    if (/extension connected/.test(textOf(await call('stats')))) break;
    await new Promise((r) => setTimeout(r, 200));
  }
}, 90000);

afterAll(async () => {
  await ctx?.close();
  await client?.close();
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('F4 end-to-end', () => {
  it('B1 extension loads with the fixed id', () => {
    expect(sw.url()).toMatch(/^chrome-extension:\/\/hmoipddaijkfcidjilmbbiodbmgedbjm\//);
  });

  it('B3 extension reaches the MCP server through the native host', async () => {
    expect(textOf(await call('stats'))).toContain('extension connected');
  });

  it('list_tabs shows the fixture tab', async () => {
    expect(textOf(await call('list_tabs'))).toContain('"Fixture Shop"');
  });

  it('E1 outline gives landmarks and headings', async () => {
    const t = textOf(await call('outline'));
    expect(t).toContain('[navigation "Main"]');
    expect(t).toMatch(/h1 "Fixture Shop"/);
    expect(t).toMatch(/h2 "Cart"/);
  });

  it('E1b read_text returns the main content', async () => {
    const t = textOf(await call('read_text'));
    expect(t).toContain('# Fixture Shop');
    expect(t).toContain('## Cart');
    expect(t).not.toContain('hunter2-secret');
  });

  it('E2 read_page is viewport-only by default and never leaks the password', async () => {
    const t = textOf(await call('read_page'));
    expect(t).not.toContain('Footer button far below');
    expect(t).toMatch(/more off-screen/);
    expect(t).not.toContain('hunter2-secret');
    expect(textOf(await call('read_page', { viewport_only: false }))).toContain('Footer button far below');
  });

  it('B2/E4 click returns only the diff', async () => {
    const ref = refFor(textOf(await call('find', { query: 'add item', role: 'button' })), 'Add item');
    const t = textOf(await call('click', { ref }));
    expect(t).toMatch(/^\+ [a-z]+\d+ button "Remove item 1"$/m);
    expect(t).not.toContain('Fixture Shop —'); // no full page dump
    expect(page.locator('#cart li')).toBeTruthy();
    expect(await page.locator('#cart li').count()).toBe(1);
  });

  it('type + submit works and the diff shows the result', async () => {
    const ref = refFor(textOf(await call('find', { query: 'search products' })), 'Search products');
    const t = textOf(await call('type', { ref, text: 'knives', submit: true }));
    expect(t).toContain('Result for knives');
    expect(await page.inputValue('#q')).toBe('knives');
  });

  it('select_option changes a real <select>', async () => {
    const ref = refFor(textOf(await call('find', { query: 'country' })), 'Country');
    await call('select_option', { ref, option: 'Germany' });
    expect(await page.inputValue('#country')).toBe('de');
  });

  it('D6 refuses to type into the password field', async () => {
    const ref = refFor(textOf(await call('find', { query: 'password' })), 'Password');
    const r = await call('type', { ref, text: 'x' });
    expect(r.isError).toBe(true);
    expect(await page.inputValue('input[type=password]')).toBe('hunter2-secret');
  });


  let oldRef;
  it('clicking a link that navigates reports the new page', async () => {
    const ref = refFor(textOf(await call('find', { query: 'second page', role: 'link' })), 'Second page');
    oldRef = refFor(textOf(await call('find', { query: 'add item' })), 'Add item');
    const t = textOf(await call('click', { ref }));
    expect(t).toMatch(/page2\.html/);
    expect(t).toMatch(/h1 "Second page"/); // new page's outline comes back in the same call
    await page.waitForURL(/page2/);
    expect(textOf(await call('outline'))).toMatch(/h1 "Second page"/);
  });

  it('A5 a ref from the previous page is rejected, not clicked on the new page', async () => {
    const r = await call('click', { ref: oldRef });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/previous page load/);
  });

  it('navigate opens a URL and returns its outline', async () => {
    const t = textOf(await call('navigate', { url: `${base}/shop.html` }));
    expect(t).toMatch(/h1 "Fixture Shop"/);
  });

  it('stale refs after navigation give a clear error', async () => {
    const r = await call('click', { ref: '999999' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/not found|previous page load/);
  });

  it('screenshot fallback returns an image', async () => {
    const r = await call('screenshot');
    expect(r.content[0].type).toBe('image');
    expect(r.content[0].data.length).toBeGreaterThan(1000);
  });

  it('D2 a redirect into a blocked site returns nothing', async () => {
    await sw.evaluate(() => chrome.storage.local.set({ blocklist: ['localhost'] }));
    const r = await call('navigate', { url: `${base}/redirect` }); // 127.0.0.1 → localhost
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/blocklist/);
    expect(textOf(r)).not.toContain('Second page');
    const tabs = textOf(await call('list_tabs'));
    expect(tabs).toMatch(/\[blocked\] localhost/);
    expect(tabs).not.toContain('Second Page"'); // no title of blocked tab
    await sw.evaluate(() => chrome.storage.local.remove('blocklist'));
    await call('navigate', { url: `${base}/shop.html` });
  });

  it('D2 blocklisted sites return nothing', async () => {
    await sw.evaluate(() => chrome.storage.local.set({ blocklist: ['127.0.0.1'] }));
    const r = await call('outline');
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/blocklist/);
    expect(textOf(r)).not.toContain('Fixture Shop —');
    await sw.evaluate(() => chrome.storage.local.remove('blocklist'));
    expect((await call('outline')).isError).toBeFalsy();
  });

  it('skills: cookie banner is auto-closed on load (privacy-friendly choice)', async () => {
    const t = textOf(await call('navigate', { url: `${base}/skills.html` }));
    expect(t).toMatch(/auto-closed cookie banner via "Reject all"/);
    expect(await page.evaluate(() => window.consent)).toBe('rejected');
  });

  it('fill_form fills text, select and checkbox by label and submits', async () => {
    const t = textOf(await call('fill_form', { fields: { 'Full name': 'Ada Lovelace', Email: 'ada@example.com', Country: 'Germany', 'I accept the terms': true }, submit: true }));
    expect(t).toMatch(/submitted via "Register"/);
    expect(await page.textContent('#out')).toBe('Thanks Ada Lovelace <ada@example.com> de terms=true');
  });

  it('batch drives a custom (non-native) dropdown by label', async () => {
    const t = textOf(await call('batch', { steps: [{ action: 'select', label: 'Size', option: 'Large' }] }));
    expect(t).toMatch(/selected "Large"/);
    expect(await page.textContent('#size')).toBe('Large');
  });

  it('batch stops at the first failing step and says why', async () => {
    const r = await call('batch', { steps: [{ action: 'type', label: 'Full name', text: 'X' }, { action: 'click', label: 'No such button zzz' }] });
    expect(textOf(r)).toMatch(/1\. typed/);
    expect(textOf(r)).toMatch(/STOPPED: step 2/);
  });

  it('label targeting: type into a field by its label, no find() needed', async () => {
    await call('navigate', { url: `${base}/shop.html` });
    const t = textOf(await call('type', { label: 'Search products', text: 'pigeon', submit: true }));
    expect(t).toContain('Result for pigeon');
  });

  it('recipes: steps are recorded (even across navigation), saved, and replayed with new values', async () => {
    await call('navigate', { url: `${base}/skills.html` });
    await call('fill_form', { fields: { 'Full name': 'Ada Lovelace', Email: 'ada@example.com', Country: 'Germany', 'I accept the terms': true }, submit: true });
    const saved = textOf(await call('save_recipe', { name: 'signup', description: 'workshop signup' }));
    expect(saved).toMatch(/saved recipe "signup" \(6 steps; params: Full name, Email, Country\)/);
    // Site memory shows up on the next visit.
    const nav = textOf(await call('navigate', { url: `${base}/skills.html` }));
    expect(nav).toMatch(/\[site memory\] recipes: signup\(Full name, Email, Country\)/);
    const run = await call('run_recipe', { name: 'signup', values: { 'Full name': 'Grace Hopper', Email: 'grace@example.com' } });
    expect(textOf(run)).toMatch(/recipe "signup" done/);
    expect(await page.textContent('#out')).toBe('Thanks Grace Hopper <grace@example.com> de terms=true');

    // A step that navigates still gets recorded.
    await call('navigate', { url: `${base}/shop.html` });
    await call('click', { label: 'Second page' });
    expect(textOf(await call('save_recipe', { name: 'to-page2' }))).toMatch(/2 steps/);
    const rs = JSON.parse(fs.readFileSync(path.join(rt, 'recipes.json'), 'utf8'));
    expect(rs.recipes['to-page2'].steps[1]).toMatchObject({ action: 'click', label: 'Second page', role: 'link' });
  });

  it('recipes: a step that no longer matches stops the run and says where', async () => {
    const f = path.join(rt, 'recipes.json');
    const db = JSON.parse(fs.readFileSync(f, 'utf8'));
    db.recipes['signup'].steps[1].label = 'Field that was renamed';
    fs.writeFileSync(f, JSON.stringify(db));
    const r = await call('run_recipe', { name: 'signup' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/STOPPED at step 2 \(type "Field that was renamed"\)/);
  });

  it('parallel: two agent sessions drive two tabs at the same time without mixing them up', async () => {
    const second = new Client({ name: 'e2e-2', version: '1.0.0' });
    await second.connect(new StdioClientTransport({
      command: process.execPath, args: [path.join(root, 'mcp/server.js')],
      env: { ...process.env, PAGEMAP_DIR: rt }, stderr: 'pipe',
    }));
    const call2 = (name, args = {}) => second.callTool({ name, arguments: args });
    let r2;
    for (let i = 0; i < 50; i++) { // host picks up the new session socket within ~0.5 s
      r2 = await call2('navigate', { url: `${base}/page2.html`, new_tab: true });
      if (!r2.isError) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const r1 = await call('navigate', { url: `${base}/shop.html`, new_tab: true });
    expect(textOf(r1)).toMatch(/h1 "Fixture Shop"/);
    expect(textOf(r2)).toMatch(/h1 "Second page"/);
    // Simultaneous calls, no tab argument: each session stays in its own tab.
    const [a, b] = await Promise.all([call('outline'), call2('outline'), call('find', { query: 'add item' }), call2('find', { query: 'back to shop' })]);
    expect(textOf(a)).toMatch(/Fixture Shop/);
    expect(textOf(b)).toMatch(/Second page/);
    expect(textOf(b)).not.toMatch(/Fixture Shop —/);
    await second.close();
  }, 30000);

  it('E5 stats shows token cost per tool', async () => {
    const t = textOf(await call('stats'));
    expect(t).toMatch(/outline: \d+ calls, ~\d+ tokens/);
    console.log('\n' + t);
  });
});

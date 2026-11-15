#!/usr/bin/env node
// F5: how many tokens does each Page-Map view cost on real pages, vs. one screenshot?
//   node scripts/bench.js [url ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = fs.readFileSync(path.join(root, 'extension/core.js'), 'utf8');
const urls = process.argv.slice(2).length ? process.argv.slice(2) : [
  'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/select',
  'https://github.com/microsoft/playwright',
  'https://news.ycombinator.com/',
  'https://www.amazon.com/',
  'https://www.youtube.com/',
];
const W = 1280, H = 800;
// Claude vision cost ≈ width*height/750 tokens per image.
const SCREENSHOT_TOKENS = Math.round((W * H) / 750);
const tok = (s) => Math.ceil(s.length / 4);

const browser = await chromium.launch({ channel: 'chromium', headless: true });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' });
const rows = [];
for (const url of urls) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.evaluate(core); // CDP evaluate is not subject to page CSP (like a content script)
    const r = await page.evaluate(() => {
      const C = globalThis.PageMapCore; const refs = C.createRefs();
      const t = (f) => { const a = performance.now(); const out = f(); return [out, Math.round(performance.now() - a)]; };
      const [outline, msO] = t(() => C.outline(window, document, refs));
      const [view, msV] = t(() => C.format(C.snapshot(window, document, refs, { viewportOnly: true, maxItems: 150 })));
      const [full, msF] = t(() => C.format(C.snapshot(window, document, refs, { maxItems: 100000 })));
      const [find, msQ] = t(() => C.find(window, document, refs, 'search', { limit: 8 }).items.map(C.formatItem).join('\n'));
      const rawHtml = document.documentElement.outerHTML.length;
      return { title: document.title, outline, view, full, find, rawHtml, ms: { msO, msV, msF, msQ } };
    });
    rows.push({ url, title: r.title, outline: tok(r.outline), viewport: tok(r.view), full: tok(r.full), find: tok(r.find), html: Math.ceil(r.rawHtml / 4), ms: r.ms });
  } catch (e) {
    rows.push({ url, error: e.message.split('\n')[0] });
  }
  await page.close();
}
await browser.close();

const pad = (s, n) => String(s).padEnd(n);
console.log(`\nEstimated tokens per view (chars/4). One ${W}×${H} screenshot ≈ ${SCREENSHOT_TOKENS} tokens.\n`);
console.log(pad('page', 42) + pad('find', 7) + pad('outline', 9) + pad('viewport', 10) + pad('full', 8) + pad('raw HTML', 10) + 'ms (outline/view/full/find)');
for (const r of rows) {
  if (r.error) { console.log(pad(r.url.slice(0, 40), 42) + 'error: ' + r.error); continue; }
  console.log(pad((r.title || r.url).slice(0, 40), 42) + pad(r.find, 7) + pad(r.outline, 9) + pad(r.viewport, 10) + pad(r.full, 8) + pad(r.html, 10) + `${r.ms.msO}/${r.ms.msV}/${r.ms.msF}/${r.ms.msQ}`);
}
const ok = rows.filter((r) => !r.error);
if (ok.length) {
  const avg = (k) => Math.round(ok.reduce((a, r) => a + r[k], 0) / ok.length);
  console.log(`\naverage: find ${avg('find')} · outline ${avg('outline')} · viewport ${avg('viewport')} · full ${avg('full')} · screenshot ${SCREENSHOT_TOKENS} · raw HTML ${avg('html')}`);
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const coreSrc = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../extension/core.js'), 'utf8');

// Build a jsdom page with core.js loaded. jsdom has no layout, so geometry is stubbed:
//   data-zero      → 0×0 box (invisible)
//   data-offscreen → below the viewport
export function page(html, url = 'https://example.com/') {
  const dom = new JSDOM(`<!doctype html><html><head><title>Test</title></head><body>${html}</body></html>`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.Element.prototype.getBoundingClientRect = function () {
    if (this.closest('[data-zero]')) return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
    const top = this.closest('[data-offscreen]') ? 5000 : 10;
    return { top, left: 10, bottom: top + 20, right: 110, width: 100, height: 20 };
  };
  win.Element.prototype.scrollIntoView = function () {};
  win.eval(coreSrc);
  const C = win.PageMapCore;
  const refs = C.createRefs();
  return { win, doc: win.document, C, refs };
}

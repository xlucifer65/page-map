import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PAGEMAP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pmr-'));
const memory = await import('../../mcp/recipes.js');

const trail = [
  { action: 'navigate', url: 'https://old.example.com/' },
  { action: 'click', label: 'ignored', role: 'button' },
  { action: 'navigate', url: 'https://en.wikipedia.org/' },
  { action: 'type', label: 'Search Wikipedia', role: 'searchbox', text: 'rock dove', submit: true },
  { action: 'type', label: 'Password', role: 'password', secret: true },
  { action: 'select', label: 'Language', role: 'combobox', option: 'English' },
  { action: 'check', label: 'Remember me', role: 'checkbox', checked: true },
];

beforeEach(() => { try { fs.unlinkSync(path.join(process.env.PAGEMAP_DIR, 'recipes.json')); } catch (_) {} });

describe('recipes', () => {
  it('saves only the steps since the last navigate, with typed values as params and no secrets', () => {
    const { recipe } = memory.saveRecipe('wiki-search', 'search wikipedia', trail);
    expect(recipe.host).toBe('en.wikipedia.org');
    expect(recipe.steps.map((s) => s.action)).toEqual(['navigate', 'type', 'type', 'select', 'check']);
    expect(recipe.params).toEqual(['Search Wikipedia', 'Password', 'Language']);
    expect(recipe.steps[2]).not.toHaveProperty('text'); // secret never stored
    const raw = fs.readFileSync(path.join(process.env.PAGEMAP_DIR, 'recipes.json'), 'utf8');
    expect(fs.statSync(path.join(process.env.PAGEMAP_DIR, 'recipes.json')).mode & 0o777).toBe(0o600);
    expect(raw).toContain('rock dove');
  });

  it('rejects bad names and empty tasks', () => {
    expect(() => memory.saveRecipe('bad name!', '', trail)).toThrow(/letters/);
    expect(() => memory.saveRecipe('x', '', [{ action: 'navigate', url: 'https://a.com/' }])).toThrow(/nothing to save/);
  });

  it('replays step by step with overridden values and reports the final page', async () => {
    memory.saveRecipe('wiki', '', trail.slice(2, 4));
    const calls = [];
    const req = async (cmd, args) => { calls.push([cmd, args]); return cmd === 'navigate' ? { ok: true, tabId: 7, text: 'tab 7' } : { ok: true, text: 'page navigated → https://en.wikipedia.org/wiki/House_sparrow\n# House sparrow' }; };
    const r = await memory.runRecipe('wiki', { 'Search Wikipedia': 'house sparrow' }, req, null);
    expect(r.ok).toBe(true);
    expect(calls[0]).toEqual(['navigate', { url: 'https://en.wikipedia.org/', new_tab: true }]);
    expect(calls[1]).toEqual(['batch', { steps: [{ action: 'type', label: 'Search Wikipedia', role: 'searchbox', text: 'house sparrow', submit: true }], tab: 7 }]);
    expect(r.text).toContain('# House sparrow');
  });

  it('stops at the first step that no longer matches, and asks for missing secrets', async () => {
    memory.saveRecipe('wiki', '', trail.slice(2));
    const req = async (cmd) => (cmd === 'navigate' ? { ok: true, tabId: 1, text: '' } : { ok: true, text: '1. typed\nSTOPPED: step 1 (type Search Wikipedia): nothing labelled "Search Wikipedia"' });
    const r = await memory.runRecipe('wiki', {}, req, null);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/STOPPED at step 2 \(type "Search Wikipedia"\)/);
    const ok = async (cmd) => ({ ok: true, tabId: 1, text: 'done' });
    const r2 = await memory.runRecipe('wiki', {}, ok, null);
    expect(r2.text).toMatch(/needs value for "Password"/);
    expect((await memory.runRecipe('nope', {}, ok, null)).text).toMatch(/unknown recipe "nope"; available: wiki/);
  });

  it('site map learns used elements and hints them with recipes on navigate', () => {
    memory.learnSite('https://en.wikipedia.org/wiki/Main_Page', [{ action: 'type', label: 'Search Wikipedia', role: 'searchbox' }]);
    memory.learnSite('https://en.wikipedia.org/wiki/X', [{ action: 'type', label: 'Search Wikipedia', role: 'searchbox' }]);
    memory.saveRecipe('wiki', '', trail.slice(2, 4));
    const h = memory.hintFor('https://en.wikipedia.org/');
    expect(h).toContain('recipes: wiki(Search Wikipedia) → run_recipe');
    expect(h).toContain('known: searchbox "Search Wikipedia"');
    expect(memory.hintFor('https://other.org/')).toBe('');
  });
});

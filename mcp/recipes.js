// Recipes + site maps, stored on disk (never in the agent's context).
//
//  recipe   = a finished task as label-based steps: [{action:'navigate', url}, {action:'type',
//             label:'Search Wikipedia', role:'searchbox', text:'rock dove', submit:true}, …].
//             Typed values become parameters, so a recipe replays with new values.
//  site map = per host: the elements actions have used (label, role, page path, times used).
//             Shown on navigate so new tasks on a known site can act by label right away.
import fs from 'node:fs';
import path from 'node:path';
import { runtimeDir } from '../host/paths.js';

const MAX_RECIPES = 200;
const MAX_SITE_ELEMENTS = 60;

const file = () => path.join(runtimeDir(), 'recipes.json');

export function load() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch (_) { return { recipes: {}, sites: {} }; }
}

function store(db) {
  fs.mkdirSync(runtimeDir(), { recursive: true, mode: 0o700 });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

export const hostOf = (url) => { try { return new URL(url).host; } catch (_) { return ''; } };
const pathOf = (url) => { try { return new URL(url).pathname; } catch (_) { return ''; } };

// ---------- site map ----------
export function learnSite(url, steps) {
  const host = hostOf(url);
  if (!host || !steps.length) return;
  const db = load();
  const site = (db.sites[host] ||= { elements: {} });
  for (const s of steps) {
    if (!s.label || s.action === 'navigate') continue;
    const key = `${s.role}|${s.label}`;
    const e = (site.elements[key] ||= { label: s.label, role: s.role, path: pathOf(url), uses: 0 });
    e.uses++;
    e.last = Date.now();
  }
  // Keep the most used / most recent elements only.
  const keep = Object.entries(site.elements).sort((a, b) => (b[1].uses - a[1].uses) || (b[1].last - a[1].last)).slice(0, MAX_SITE_ELEMENTS);
  site.elements = Object.fromEntries(keep);
  store(db);
}

// One compact line for the agent: known elements + recipes for this host.
export function hintFor(url) {
  const host = hostOf(url);
  const db = load();
  const parts = [];
  const rs = Object.values(db.recipes).filter((r) => r.host === host);
  if (rs.length) parts.push('recipes: ' + rs.slice(0, 8).map((r) => `${r.name}(${r.params.join(', ')})`).join('; ') + ' → run_recipe');
  const els = Object.values((db.sites[host] || {}).elements || {}).slice(0, 12);
  if (els.length) parts.push('known: ' + els.map((e) => `${e.role} "${e.label}"`).join(', '));
  return parts.length ? `[site memory] ${parts.join(' | ')}` : '';
}

// ---------- recipes ----------
export function saveRecipe(name, description, trail) {
  if (!/^[\w.-]{1,60}$/.test(name)) throw new Error('name: letters, digits, - _ . only');
  // The task = everything since the last navigate.
  let start = -1;
  for (let i = trail.length - 1; i >= 0; i--) if (trail[i].action === 'navigate') { start = i; break; }
  const steps = (start >= 0 ? trail.slice(start) : trail).map((s) => ({ ...s }));
  if (!steps.some((s) => s.action !== 'navigate')) throw new Error('nothing to save: no actions since the last navigate');
  const unlabeled = steps.filter((s) => s.action !== 'navigate' && !s.label).length;
  const params = [];
  for (const s of steps) {
    if (s.action === 'type' || s.action === 'select') {
      const key = s.label || `field${params.length + 1}`;
      s.param = key;
      if (!params.includes(key)) params.push(key);
      if (s.secret) delete s.text; // secrets are never stored: they must be passed at run time
    }
  }
  const startUrl = steps[0].action === 'navigate' ? steps[0].url : null;
  const db = load();
  db.recipes[name] = { name, description: description || '', host: hostOf(startUrl || ''), start_url: startUrl, steps, params, created: new Date().toISOString(), runs: 0 };
  const names = Object.values(db.recipes).sort((a, b) => (b.last_run || b.created).localeCompare(a.last_run || a.created)).map((r) => r.name);
  for (const n of names.slice(MAX_RECIPES)) delete db.recipes[n];
  store(db);
  return { recipe: db.recipes[name], unlabeled };
}

export function listRecipes() {
  return Object.values(load().recipes);
}

// Replay step by step through `request(cmd, args)` (the bridge). Each step is checked on the live
// page (found by label/role); a failing step stops the run and returns where it stopped, so the
// agent fixes only that step instead of redoing the task.
export async function runRecipe(name, values, request, tab) {
  const db = load();
  const r = db.recipes[name];
  if (!r) {
    const names = Object.keys(db.recipes);
    return { ok: false, text: `unknown recipe "${name}"${names.length ? '; available: ' + names.join(', ') : ''}` };
  }
  const log = [];
  let last = '';
  let tabId = tab;
  for (let i = 0; i < r.steps.length; i++) {
    const s = r.steps[i];
    let res;
    if (s.action === 'navigate') {
      res = await request('navigate', tabId != null ? { url: s.url, tab: tabId } : { url: s.url, new_tab: true });
      if (res.tabId != null) tabId = res.tabId;
    } else {
      const step = { action: s.action, label: s.label, role: s.role };
      if (s.action === 'type') {
        const v = values && s.param in values ? values[s.param] : s.text;
        if (v == null) return { ok: false, tabId, text: `${log.join('\n')}\nSTOPPED at step ${i + 1}: needs value for "${s.param}"` };
        step.text = String(v);
        if (s.submit) step.submit = true;
      }
      if (s.action === 'select') step.option = String(values && s.param in values ? values[s.param] : s.option);
      if (s.action === 'check') step.checked = s.checked;
      res = await request('batch', { steps: [step], tab: tabId });
    }
    if (!res.ok || /STOPPED:/.test(res.text || '')) {
      return { ok: false, tabId, text: `${log.join('\n')}\nSTOPPED at step ${i + 1} (${s.action} "${s.label || s.url}"): ${res.error || (res.text || '').split('STOPPED:')[1] || 'failed'}\nThe page may have changed: do this step yourself, then continue.` };
    }
    log.push(`${i + 1}. ${s.action} ${s.label ? `"${s.label}"` : s.url} ✓`);
    last = res.text || '';
  }
  r.runs = (r.runs || 0) + 1;
  r.last_run = new Date().toISOString();
  store(db);
  // Last step's result already contains the final page (diff, or new page outline + preview).
  return { ok: true, tabId, text: `recipe "${name}" done (${r.steps.length} steps)\n${log.join('\n')}\n--- final page ---\n${last.split('\n').slice(0, 60).join('\n')}` };
}

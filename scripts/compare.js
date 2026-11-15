#!/usr/bin/env node
// Head-to-head: the same tasks done by Claude through Page-Map "structure" tools vs. a
// classic screenshot + pixel-click loop ("vision" mode), in the same Chrome.
//   node scripts/compare.js [--runs 1] [--only github,form] [--modes structure,vision]
// Needs: Chrome open with the Page-Map extension loaded, `npm run install-host` done,
// and no other page-map MCP server running (close other Claude Code sessions using it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const RUNS = Number(arg('--runs', 1));
const ONLY = arg('--only') ? arg('--only').split(',') : null;
const MODES = arg('--modes', 'structure,vision').split(',');
const RUN_TIMEOUT = 8 * 60 * 1000;
const PARALLEL = process.argv.includes('--parallel');
const RECIPES = process.argv.includes('--recipes'); // learn → replay-with-new-values → zero-token CLI // extra round: all tasks at once in structure mode

// ---------- local form fixture with server-side verification ----------
const issued = new Map(); // code -> submitted fields
const FORM = `<!doctype html><html><head><meta charset="utf-8"><title>Signup</title>
<style>body{font:16px system-ui;max-width:520px;margin:40px auto}label{display:block;margin:14px 0}input,select{font-size:16px;padding:6px;width:100%}</style></head>
<body><h1>Workshop signup</h1>
<form id="f">
<label>Full name <input name="name" required></label>
<label>Email <input name="email" type="email" required></label>
<label>Country <select name="country"><option value="">Choose…</option><option value="fr">France</option><option value="de">Germany</option><option value="es">Spain</option></select></label>
<label><input type="checkbox" name="terms" style="width:auto"> I accept the terms</label>
<button type="submit">Register</button></form>
<p id="out" role="status"></p>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { name: f.name.value, email: f.email.value, country: f.country.value, terms: f.terms.checked };
  const r = await fetch('/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  document.getElementById('out').textContent = j.ok ? 'Registered! Confirmation code: ' + j.code : 'Error: ' + j.error;
});
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/submit') {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      let d = {};
      try { d = JSON.parse(b); } catch (_) {}
      const code = 'PM-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      issued.set(code, d);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, code }));
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(FORM);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const formUrl = `http://127.0.0.1:${server.address().port}/form.html`;

// ---------- tasks ----------
const getJson = async (u) => (await fetch(u, { headers: { 'user-agent': 'page-map-bench' } })).json();
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const TASKS = [
  {
    id: 'github',
    prompt: 'Go to https://github.com/microsoft/playwright/releases and find the version number of the latest release.',
    check: async (a) => {
      const tag = (await getJson('https://api.github.com/repos/microsoft/playwright/releases/latest')).tag_name.replace(/^v/, '');
      return { ok: a.includes(tag), expected: tag };
    },
  },
  {
    id: 'hackernews',
    prompt: 'Go to https://news.ycombinator.com and find the exact title of the story ranked #1 on the front page.',
    check: async (a) => {
      const [id] = await getJson('https://hacker-news.firebaseio.com/v0/topstories.json');
      const { title } = await getJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      const x = norm(a), t = norm(title);
      return { ok: x.includes(t.slice(0, 25)) || t.includes(x.slice(0, 25)), expected: title, note: 'ranking can shift during a run' };
    },
  },
  {
    id: 'wikipedia',
    prompt: 'Go to https://en.wikipedia.org, use the site\'s search box to search for "rock dove", open the article, and find the bird\'s scientific (binomial) name.',
    check: async (a) => ({ ok: /columba\s+livia/i.test(a), expected: 'Columba livia' }),
  },
  {
    id: 'mdn',
    prompt: 'Go to https://developer.mozilla.org/en-US/docs/Web/HTML/Element/select and find, in one sentence, what the `multiple` attribute does.',
    check: async (a) => ({ ok: /(more than one|zero or more|one or more|multiple (options|values|items|selections)|several)/i.test(a), expected: 'allows selecting more than one option' }),
  },
  {
    id: 'form',
    prompt: `Go to ${formUrl}, fill in the form with full name "Ada Lovelace", email "ada@example.com", country Germany, tick the terms checkbox, submit it, and report the confirmation code that appears.`,
    check: async (a) => {
      const m = a.match(/PM-[0-9A-F]{6}/);
      const d = m && issued.get(m[0]);
      const ok = !!d && d.name === 'Ada Lovelace' && d.email === 'ada@example.com' && d.country === 'de' && d.terms === true;
      return { ok, expected: 'valid code + correct fields', got: d || null };
    },
  },
].filter((t) => !ONLY || ONLY.includes(t.id));

const PREAMBLE = {
  structure: 'You control a Chrome browser only through the page-map tools (they read the page structure). ',
  vision: 'You control a Chrome browser only through the page-map tools: you see the page through screenshots and act with pixel coordinates. ',
};
const SUFFIX = ' Begin by calling navigate with new_tab=true. Do not ask questions. End your reply with a final line in the form: ANSWER: <answer>';

// ---------- runner ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmcmp-'));
function mcpConfig(mode) {
  const f = path.join(tmp, `mcp-${mode}.json`);
  fs.writeFileSync(f, JSON.stringify({
    mcpServers: { 'page-map': { command: process.execPath, args: [path.join(root, 'mcp/server.js')], env: { PAGEMAP_MODE: mode } } },
  }));
  return f;
}

function runClaude(prompt, mode) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config',
      '--mcp-config', mcpConfig(mode), '--tools', '', '--allowedTools', 'mcp__page-map'];
    const p = spawn('claude', args, { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    const timer = setTimeout(() => p.kill('SIGTERM'), RUN_TIMEOUT);
    p.on('close', (code) => {
      clearTimeout(timer);
      // stream-json: one event per line. Keep the final result + a trace of every tool call.
      const trace = [];
      let result = null;
      for (const line of out.split('\n')) {
        let ev;
        try { ev = JSON.parse(line); } catch (_) { continue; }
        if (ev.type === 'assistant') {
          for (const c of (ev.message && ev.message.content) || []) {
            if (c.type === 'tool_use') trace.push({ tool: c.name.replace(/^mcp__page-map__/, ''), input: JSON.stringify(c.input).slice(0, 120) });
          }
        } else if (ev.type === 'user') {
          for (const c of (ev.message && ev.message.content) || []) {
            if (c.type === 'tool_result' && trace.length) {
              const body = Array.isArray(c.content) ? c.content.map((x) => x.text || (x.type === 'image' ? '[image]' : '')).join('') : String(c.content || '');
              trace[trace.length - 1].result_chars = body.length;
              if (c.is_error) trace[trace.length - 1].error = body.slice(0, 160);
            }
          }
        } else if (ev.type === 'result') result = ev;
      }
      if (result) resolve({ ...result, trace });
      else resolve({ is_error: true, trace, result: `exit ${code}: ${err.slice(-400) || out.slice(-400)}` });
    });
  });
}

const results = [];
for (const task of TASKS) {
  for (let r = 0; r < RUNS; r++) {
    // Alternate order so neither mode always goes first (pages can change over time).
    const order = (r + TASKS.indexOf(task)) % 2 ? [...MODES].reverse() : MODES;
    for (const mode of order) {
      process.stderr.write(`→ ${task.id} [${mode}] run ${r + 1}/${RUNS} … `);
      const t0 = Date.now();
      const j = await runClaude(PREAMBLE[mode] + task.prompt + SUFFIX, mode);
      const wall = Date.now() - t0;
      const u = j.usage || {};
      const tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
      const answer = ((j.result || '').match(/ANSWER:\s*(.+)\s*$/m) || [])[1] || (j.result || '').slice(-200);
      const check = j.is_error ? { ok: false, expected: '(run failed)' } : await task.check(answer).catch((e) => ({ ok: false, expected: 'checker error: ' + e.message }));
      const row = { task: task.id, mode, run: r + 1, ok: check.ok, answer: answer.trim(), expected: check.expected, tokens,
        input_tokens: u.input_tokens, cache_creation: u.cache_creation_input_tokens, cache_read: u.cache_read_input_tokens,
        output_tokens: u.output_tokens, cost_usd: j.total_cost_usd, seconds: Math.round(wall / 100) / 10, turns: j.num_turns,
        trace: j.trace,
        error: j.is_error ? String(j.result).slice(0, 300) : undefined };
      results.push(row);
      process.stderr.write(`${row.ok ? 'PASS' : 'FAIL'} · ${tokens} tok · ${row.seconds}s · ${row.turns} turns · ${(j.trace || []).map((t) => t.tool).join(' → ')}\n`);
    }
  }
}
// ---------- recipes round ----------
async function runCli(args) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [path.join(root, 'scripts/recipe.js'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { out += c; });
    p.on('close', (code) => resolve({ ok: code === 0, out, seconds: Math.round((Date.now() - t0) / 100) / 10 }));
  });
}

const recipeRows = [];
if (RECIPES) {
  const RT = [
    {
      id: 'wikipedia', recipe: 'wiki-search',
      learn: TASKS.find((t) => t.id === 'wikipedia')?.prompt || 'Go to https://en.wikipedia.org, use the site\'s search box to search for "rock dove", open the article, and find the bird\'s scientific (binomial) name.',
      replay: 'Go to https://en.wikipedia.org, use the site\'s search box to search for "house sparrow", open the article, and find the bird\'s scientific (binomial) name.',
      checkReplay: async (a) => /passer\s+domesticus/i.test(a),
      cli: ['run', 'wiki-search', '--Search Wikipedia=house sparrow'],
      checkCli: async (out) => /House sparrow/i.test(out),
    },
    {
      id: 'form', recipe: 'signup-form',
      learn: TASKS.find((t) => t.id === 'form')?.prompt,
      replay: `Go to ${formUrl}, fill in the form with full name "Grace Hopper", email "grace@example.com", country Germany, tick the terms checkbox, submit it, and report the confirmation code that appears.`,
      checkReplay: async (a) => { const m = a.match(/PM-[0-9A-F]{6}/); const d = m && issued.get(m[0]); return !!d && d.name === 'Grace Hopper' && d.email === 'grace@example.com' && d.country === 'de' && d.terms === true; },
      cli: ['run', 'signup-form', '--Full name=Alan Turing', '--Email=alan@example.com'],
      checkCli: async () => [...issued.values()].some((d) => d.name === 'Alan Turing' && d.email === 'alan@example.com' && d.country === 'de' && d.terms === true),
    },
  ].filter((t) => t.learn && (!ONLY || ONLY.includes(t.id)));

  for (const t of RT) {
    await runCli(['delete', t.recipe]);
    for (const phase of ['learn', 'replay', 'cli']) {
      process.stderr.write(`→ recipes ${t.id} [${phase}] … `);
      let row;
      if (phase === 'cli') {
        const c = await runCli(t.cli);
        row = { task: t.id, phase, ok: c.ok && await t.checkCli(c.out), tokens: 0, cost_usd: 0, seconds: c.seconds, turns: 0, trace: [] };
      } else {
        const prompt = PREAMBLE.structure + (phase === 'learn' ? t.learn + ` When the task is done, call save_recipe with name "${t.recipe}".` : t.replay) + SUFFIX;
        const t0 = Date.now();
        const j = await runClaude(prompt, 'structure');
        const u = j.usage || {};
        const answer = ((j.result || '').match(/ANSWER:\s*(.+)\s*$/m) || [])[1] || '';
        const ok = phase === 'learn' ? /PM-|columba/i.test(answer) && listedRecipe(t.recipe) : await t.checkReplay(answer);
        row = { task: t.id, phase, ok, answer: answer.slice(0, 60), tokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0),
          cost_usd: j.total_cost_usd || 0, seconds: Math.round((Date.now() - t0) / 100) / 10, turns: j.num_turns, trace: j.trace };
      }
      recipeRows.push(row);
      process.stderr.write(`${row.ok ? 'PASS' : 'FAIL'} · ${row.tokens} tok · $${row.cost_usd.toFixed(3)} · ${row.seconds}s · ${(row.trace || []).map((x) => x.tool).join(' → ') || 'no AI'}\n`);
    }
  }
}

function listedRecipe(name) {
  try { return !!JSON.parse(fs.readFileSync(path.join(os.homedir(), '.page-map', 'recipes.json'), 'utf8')).recipes[name]; } catch (_) { return false; }
}

// ---------- parallel round: every task at the same time, structure mode ----------
let parallel = null;
if (PARALLEL) {
  process.stderr.write(`→ parallel round: ${TASKS.length} tasks at once [structure] … `);
  const t0 = Date.now();
  const rows = await Promise.all(TASKS.map(async (task) => {
    const j = await runClaude(PREAMBLE.structure + task.prompt + SUFFIX, 'structure');
    const answer = ((j.result || '').match(/ANSWER:\s*(.+)\s*$/m) || [])[1] || '';
    const check = j.is_error ? { ok: false } : await task.check(answer).catch(() => ({ ok: false }));
    return { task: task.id, ok: check.ok, seconds: Math.round((j.duration_ms || 0) / 100) / 10, cost_usd: j.total_cost_usd || 0, trace: j.trace };
  }));
  const wall = Math.round((Date.now() - t0) / 100) / 10;
  parallel = { wall_seconds: wall, rows };
  process.stderr.write(`${rows.filter((r) => r.ok).length}/${rows.length} ok · ${wall}s wall\n`);
}
server.close();

// ---------- report ----------
const outDir = path.join(root, 'bench-results');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
fs.writeFileSync(path.join(outDir, `compare-${stamp}.json`), JSON.stringify({ results, parallel, recipes: recipeRows }, null, 2));

const pad = (s, n) => String(s).padEnd(n);
console.log('\n' + pad('task', 12) + pad('mode', 11) + pad('ok', 5) + pad('tokens', 10) + pad('cost $', 9) + pad('sec', 8) + pad('turns', 7) + 'answer');
for (const r of results) {
  console.log(pad(r.task, 12) + pad(r.mode, 11) + pad(r.ok ? 'yes' : 'NO', 5) + pad(r.tokens, 10) + pad((r.cost_usd || 0).toFixed(3), 9) + pad(r.seconds, 8) + pad(r.turns ?? '-', 7) + (r.error ? 'ERROR ' + r.error : r.answer).slice(0, 60));
}
const agg = (mode) => {
  const rs = results.filter((r) => r.mode === mode);
  const sum = (k) => rs.reduce((a, r) => a + (r[k] || 0), 0);
  return { n: rs.length, ok: rs.filter((r) => r.ok).length, tokens: sum('tokens'), cost: sum('cost_usd'), sec: sum('seconds'), turns: sum('turns') };
};
console.log('');
for (const m of MODES) {
  const a = agg(m);
  console.log(`${pad(m, 10)} success ${a.ok}/${a.n} · total ${a.tokens} tokens · $${a.cost.toFixed(2)} · ${Math.round(a.sec)} s · ${a.turns} turns`);
}
if (MODES.length === 2) {
  const [s, v] = MODES.map(agg);
  if (s.tokens && s.sec) console.log(`\n${MODES[1]} / ${MODES[0]}: ${(v.tokens / s.tokens).toFixed(1)}× tokens · ${(v.cost / s.cost).toFixed(1)}× cost · ${(v.sec / s.sec).toFixed(1)}× time`);
}
if (recipeRows.length) {
  console.log('\nrecipes: learn once, then replay with NEW values');
  for (const r of recipeRows) console.log(`  ${pad(r.task, 11)}${pad(r.phase, 8)}${pad(r.ok ? 'yes' : 'NO', 5)}${pad(r.tokens, 9)}$${r.cost_usd.toFixed(3)}  ${r.seconds}s  ${(r.trace || []).map((x) => x.tool).join(' → ') || '(no AI)'}`);
}
if (parallel) {
  // Screenshots need the one visible tab, so they can't run side by side: compare against
  // the sequential vision time for one run of each task.
  const visSeq = results.filter((r) => r.mode === 'vision' && r.run === 1).reduce((a, r) => a + r.seconds, 0);
  const strSeq = results.filter((r) => r.mode === 'structure' && r.run === 1).reduce((a, r) => a + r.seconds, 0);
  console.log(`\nparallel (structure, all ${parallel.rows.length} tasks at once): ${parallel.rows.filter((r) => r.ok).length}/${parallel.rows.length} ok in ${parallel.wall_seconds} s wall`);
  console.log(`  vs one-at-a-time: structure ${Math.round(strSeq)} s · screenshots ${Math.round(visSeq)} s (screenshots cannot run in parallel)`);
}
console.log(`\nraw results: bench-results/compare-${stamp}.json`);

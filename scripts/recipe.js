#!/usr/bin/env node
// Replay recipes with ZERO model tokens — no AI involved, just the extension.
//   node scripts/recipe.js list
//   node scripts/recipe.js run <name> [--"Label"=value ...]
//   node scripts/recipe.js delete <name>
import fs from 'node:fs';
import path from 'node:path';
import { Bridge } from '../mcp/bridge.js';
import { sessionSocket, runtimeDir } from '../host/paths.js';
import { listRecipes, runRecipe, load } from '../mcp/recipes.js';

const [cmd, name, ...rest] = process.argv.slice(2);
if (cmd === 'list' || !cmd) {
  const rs = listRecipes();
  if (!rs.length) console.log('no recipes yet (agents create them with save_recipe)');
  for (const r of rs) console.log(`${r.name}  [${r.host}]  ${r.steps.length} steps  params: ${r.params.join(', ') || '-'}  runs: ${r.runs || 0}${r.description ? '  — ' + r.description : ''}`);
  process.exit(0);
}
if (cmd === 'delete') {
  const db = load();
  delete db.recipes[name];
  fs.writeFileSync(path.join(runtimeDir(), 'recipes.json'), JSON.stringify(db, null, 1), { mode: 0o600 });
  console.log(`deleted ${name}`);
  process.exit(0);
}
if (cmd !== 'run' || !name) { console.error('usage: recipe.js list | run <name> [--Label=value] | delete <name>'); process.exit(2); }

const values = {};
for (const a of rest) { const m = /^--([^=]+)=(.*)$/.exec(a); if (m) values[m[1]] = m[2]; }
const b = new Bridge(sessionSocket());
await b.listen();
if (!(await b.waitForConnection(8000))) { console.error('extension not connected'); b.close(); process.exit(1); }
const t0 = Date.now();
const r = await runRecipe(name, values, (c, args) => b.request(c, args), null);
console.log(r.text);
console.log(`\n${r.ok ? 'done' : 'stopped'} in ${((Date.now() - t0) / 1000).toFixed(1)} s · 0 model tokens`);
b.close();
process.exit(r.ok ? 0 : 1);

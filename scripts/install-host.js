#!/usr/bin/env node
// Registers the native messaging host with Chrome (user level, macOS/Linux).
//   node scripts/install-host.js                      → real Chrome profile
//   node scripts/install-host.js --hosts-dir <dir> --runtime-dir <dir>   → tests
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };

export function extensionIdFromKey(b64) {
  const hex = crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

function defaultHostsDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts');
  if (process.platform === 'linux') return path.join(home, '.config/google-chrome/NativeMessagingHosts');
  throw new Error('Windows needs a registry key; not supported by this script yet');
}

// Homebrew's execPath is versioned (/opt/homebrew/Cellar/node/26.8.1/...), which breaks on upgrade.
// Prefer the stable symlink when it points at the same binary.
function stableNode() {
  for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    try { if (fs.realpathSync(p) === fs.realpathSync(process.execPath)) return p; } catch (_) {}
  }
  return process.execPath;
}

export function install({ hostsDir = defaultHostsDir(), runtimeDir } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
  const id = extensionIdFromKey(manifest.key);
  const rt = runtimeDir || path.join(os.homedir(), '.page-map');
  fs.mkdirSync(rt, { recursive: true, mode: 0o700 });

  // Chrome starts the host with a minimal environment, so pin the absolute node path.
  // Single-quote for sh so paths containing $ or ` are never expanded. Re-run after upgrading node.
  const node = stableNode();
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const wrapper = path.join(rt, 'run-host.sh');
  const envLine = runtimeDir ? `export PAGEMAP_DIR=${q(rt)}\n` : '';
  fs.writeFileSync(wrapper, `#!/bin/sh\n${envLine}exec ${q(node)} ${q(path.join(root, 'host/native-host.js'))} "$@"\n`, { mode: 0o700 });

  fs.mkdirSync(hostsDir, { recursive: true });
  const hostManifest = {
    name: 'com.pagemap.host',
    description: 'Page-Map native host (relays to the local MCP server)',
    path: wrapper,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${id}/`],
  };
  const out = path.join(hostsDir, 'com.pagemap.host.json');
  fs.writeFileSync(out, JSON.stringify(hostManifest, null, 2));
  return { id, manifestPath: out, wrapper };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = install({ hostsDir: arg('--hosts-dir'), runtimeDir: arg('--runtime-dir') });
  console.log(`extension id: ${r.id}\nhost manifest: ${r.manifestPath}\nwrapper: ${r.wrapper}`);
  console.log('\nNext: load ./extension in chrome://extensions (Developer mode → Load unpacked), then:');
  console.log(`  claude mcp add -s user page-map -- ${stableNode()} ${path.join(root, 'mcp/server.js')}`);
}

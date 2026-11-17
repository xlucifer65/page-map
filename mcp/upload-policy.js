// Which local files an agent may upload. A web page can try to talk the agent into uploading
// ~/.ssh/id_rsa or a .env file; this policy makes that impossible regardless of what the agent asks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

const SECRET_EXT = /\.(pem|key|p12|pfx|keychain|keychain-db|kdbx|ovpn|gpg|asc)$/i;
const SECRET_NAME = /^(id_[a-z0-9]+|credentials|secrets?\.(json|ya?ml|toml)|.*\.env(\..*)?)$/i;

export function allowedDirs(env = process.env, home = os.homedir()) {
  const extra = (env.PAGEMAP_UPLOAD_DIRS || '').split(':').map((s) => s.trim()).filter(Boolean);
  const dirs = extra.length ? extra : ['Desktop', 'Documents', 'Downloads'].map((d) => path.join(home, d));
  return dirs.map((d) => path.resolve(d.replace(/^~(?=$|\/)/, home)));
}

// Returns { ok: true, real, size, name } or { ok: false, error }.
export function checkFile(p, { env = process.env, home = os.homedir() } = {}) {
  const input = String(p || '').replace(/^~(?=$|\/)/, home);
  // Refuse forbidden locations before touching the disk, so a page can't probe which private files exist.
  const pre = locationError(path.resolve(input), p, env, home);
  if (pre) return { ok: false, error: pre };
  let real;
  try { real = fs.realpathSync(path.resolve(input)); } catch (_) { return { ok: false, error: `not found: ${p}` }; }
  let st;
  try { st = fs.statSync(real); } catch (_) { return { ok: false, error: `not readable: ${p}` }; }
  if (!st.isFile()) return { ok: false, error: `not a file: ${p}` };

  // Same rules again on the real path (catches symlinks that point outside the allowed folders).
  const post = locationError(real, p, env, home);
  if (post) return { ok: false, error: post };
  if (st.size > MAX_FILE_BYTES) return { ok: false, error: `larger than ${MAX_FILE_BYTES / 1048576} MB: ${p}` };
  return { ok: true, real, size: st.size, name: path.basename(real) };
}

function locationError(target, shown, env, home) {
  // Compare against both the configured and the real (resolved) form of each allowed folder.
  const dirs = allowedDirs(env, home).flatMap((d) => { try { return [d, fs.realpathSync(d)]; } catch (_) { return [d]; } });
  const inside = dirs.find((d) => target === d || target.startsWith(d + path.sep));
  if (!inside) return `outside upload folders (${allowedDirs(env, home).join(', ')}): ${shown}`;
  const rel = path.relative(inside, target).split(path.sep);
  if (rel.some((seg) => seg.startsWith('.'))) return `hidden files/folders are never uploaded: ${shown}`;
  if (target.split(path.sep).includes('Library')) return `Library files are never uploaded: ${shown}`;
  const base = path.basename(target);
  if (SECRET_EXT.test(base) || SECRET_NAME.test(base)) return `looks like a key/secret file, refused: ${shown}`;
  return null;
}

const TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html',
  zip: 'application/zip', mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
export const mimeOf = (name) => TYPES[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

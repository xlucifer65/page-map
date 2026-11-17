import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkFile, allowedDirs, mimeOf } from '../../mcp/upload-policy.js';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pmup-')));
const mk = (rel, bytes = 10) => { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(bytes, 97)); return p; };
const env = {};
const ok = (p) => checkFile(p, { env, home });

describe('upload policy', () => {
  it('defaults to Desktop, Documents, Downloads', () => {
    expect(allowedDirs(env, home)).toEqual(['Desktop', 'Documents', 'Downloads'].map((d) => path.join(home, d)));
  });
  it('allows normal files in allowed folders (and ~ paths)', () => {
    mk('Documents/report.pdf');
    expect(ok(path.join(home, 'Documents/report.pdf'))).toMatchObject({ ok: true, name: 'report.pdf', size: 10 });
    expect(ok('~/Documents/report.pdf').ok).toBe(true);
  });
  it('refuses files outside the allowed folders', () => {
    mk('Projects/app/main.js');
    expect(ok(path.join(home, 'Projects/app/main.js')).error).toMatch(/outside upload folders/);
  });
  it('refuses hidden files/folders, Library, and key/secret files even inside allowed folders', () => {
    mk('Documents/.ssh/id_rsa');
    mk('Downloads/project/.env');
    mk('Documents/certs/server.pem');
    mk('Desktop/id_ed25519');
    mk('Documents/Library/x.txt');
    expect(ok(path.join(home, 'Documents/.ssh/id_rsa')).error).toMatch(/hidden/);
    expect(ok(path.join(home, 'Downloads/project/.env')).error).toMatch(/hidden/);
    expect(ok(path.join(home, 'Documents/certs/server.pem')).error).toMatch(/secret/);
    expect(ok(path.join(home, 'Desktop/id_ed25519')).error).toMatch(/secret/);
    expect(ok(path.join(home, 'Documents/Library/x.txt')).error).toMatch(/Library/);
  });
  it('refuses symlinks that escape the allowed folders', () => {
    const secret = mk('private/notes.txt');
    fs.symlinkSync(secret, path.join(home, 'Downloads/innocent.txt'));
    expect(ok(path.join(home, 'Downloads/innocent.txt')).error).toMatch(/outside upload folders/);
  });
  it('refuses forbidden paths without revealing whether they exist', () => {
    const r1 = ok(path.join(home, '.ssh/id_rsa'));            // does not exist
    mk('.ssh/id_ed25519');
    const r2 = ok(path.join(home, '.ssh/id_ed25519'));        // exists
    expect(r1.error).toMatch(/outside upload folders/);
    expect(r2.error).toMatch(/outside upload folders/);
    expect(ok(path.join(home, 'Documents/.secret/missing.txt')).error).toMatch(/hidden/);
  });
  it('refuses files over 25 MB, directories and missing files', () => {
    mk('Downloads/huge.bin', 26 * 1024 * 1024);
    expect(ok(path.join(home, 'Downloads/huge.bin')).error).toMatch(/larger than 25 MB/);
    expect(ok(path.join(home, 'Downloads')).error).toMatch(/not a file/);
    expect(ok(path.join(home, 'Downloads/nope.pdf')).error).toMatch(/not found/);
  });
  it('PAGEMAP_UPLOAD_DIRS replaces the defaults', () => {
    const p = mk('Projects/assets/logo.png');
    expect(checkFile(p, { env: { PAGEMAP_UPLOAD_DIRS: path.join(home, 'Projects/assets') }, home }).ok).toBe(true);
    expect(checkFile(path.join(home, 'Documents/report.pdf'), { env: { PAGEMAP_UPLOAD_DIRS: path.join(home, 'Projects/assets') }, home }).ok).toBe(false);
  });
  it('maps common types', () => {
    expect(mimeOf('a.PDF')).toBe('application/pdf');
    expect(mimeOf('x.unknown')).toBe('application/octet-stream');
  });
});

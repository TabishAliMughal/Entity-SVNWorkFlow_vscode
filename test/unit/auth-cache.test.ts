import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authDirOf, deleteAuthEntries, listAuthCache, originFromRealm, originOf, parseHashFile } from '../../src/auth/model';

const hash = (pairs: Record<string, string>): string =>
  Object.entries(pairs).map(([k, v]) => `K ${Buffer.byteLength(k)}\n${k}\nV ${Buffer.byteLength(v)}\n${v}\n`).join('') + 'END\n';

const SCRATCH = (fs.existsSync('F:\\TrashCache') ? 'F:\\TrashCache' : os.tmpdir());
let root: string;
beforeEach(() => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  root = fs.mkdtempSync(path.join(SCRATCH, 'auth-unit-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function put(kind: string, name: string, pairs: Record<string, string>): string {
  const dir = path.join(root, 'Subversion', 'auth', kind);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, hash(pairs));
  return f;
}

describe('auth cache', () => {
  it('parses svn hash files', () => {
    const m = parseHashFile(Buffer.from(hash({ username: 'tester', password: 'sec ret\nx', 'svn:realmstring': '<svn://h:1> r' })));
    expect(m.get('username')?.toString()).toBe('tester');
    expect(m.get('password')?.toString()).toBe('sec ret\nx');
    expect(m.get('svn:realmstring')?.toString()).toBe('<svn://h:1> r');
  });
  it('computes origins with default ports', () => {
    expect(originOf('https://Host/svn/x')).toBe('https://host:443');
    expect(originOf('svn://h/r')).toBe('svn://h:3690');
    expect(originFromRealm('<svn://127.0.0.1:13690> alpha realm')).toBe('svn://127.0.0.1:13690');
    expect(originFromRealm('https://127.0.0.1:18443')).toBe('https://127.0.0.1:18443');
  });
  it('lists entries without exposing passwords and matches configured repos', async () => {
    put('svn.simple', 'a1', { username: 'tester', password: 'TOPSECRET', 'svn:realmstring': '<svn://127.0.0.1:13690> alpha' });
    put('svn.simple', 'a2', { username: 'other', password: 'x', 'svn:realmstring': '<svn://elsewhere:3690> z' });
    put('svn.ssl.server', 'c1', { 'svn:realmstring': 'https://127.0.0.1:18443', failures: '8' });
    const dir = authDirOf({ APPDATA: root })!;
    const list = await listAuthCache(dir, [
      { name: 'alpha', serverUrl: 'svn://127.0.0.1:13690/alpha' },
      { name: 'beta', serverUrl: 'https://127.0.0.1:18443/svn/beta' },
    ]);
    expect(JSON.stringify(list)).not.toContain('TOPSECRET');
    expect(list.filter((e) => e.repos.length).map((e) => e.repos[0]).sort()).toEqual(['alpha', 'beta']);
    expect(list.find((e) => e.kind === 'svn.simple' && e.username === 'other')?.repos).toEqual([]);
  });
  it('deletes only the given files inside the auth dir', async () => {
    const f1 = put('svn.simple', 'a1', { 'svn:realmstring': '<svn://h:3690> a' });
    const f2 = put('svn.simple', 'a2', { 'svn:realmstring': '<svn://i:3690> a' });
    const outside = path.join(root, 'keep.txt');
    fs.writeFileSync(outside, 'x');
    const dir = authDirOf({ APPDATA: root })!;
    expect(await deleteAuthEntries(dir, [{ file: f1 }, { file: outside }])).toBe(1);
    expect(fs.existsSync(f1)).toBe(false);
    expect(fs.existsSync(f2)).toBe(true);
    expect(fs.existsSync(outside)).toBe(true);
  });
  it('returns an empty list when there is no cache', async () => {
    expect(await listAuthCache(path.join(root, 'none'), [])).toEqual([]);
    expect(authDirOf({})).toBeUndefined();
  });
});

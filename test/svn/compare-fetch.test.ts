/**
 * Live tests of incoming-content fetching (src/compare/fetch.ts) against the local servers: HEAD vs older
 * revisions, remote-added files without a local copy, deleted files, binary detection, encodings.
 * Scratch checkouts live under F:\TrashCache\svn-compare-vitest. Skipped when servers or svn.exe are missing.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll,beforeAll, describe, expect, it } from 'vitest';
import { rmTree, runDir } from './scratch';
import { fetchContent, resolveCatTarget } from '../../src/compare/fetch';
import { Credentials, SvnClient, pegSafe } from '../../src/svn/client';
import { parseBlame, parseInfo } from '../../src/svn/xml';
import { parseUpdateConflicts } from '../../src/ops/targets';
import { findSvnExe } from '../../src/svn/discovery';
import { SvnLocator } from '../../src/svn/locator';

const BASE = runDir('svn-compare-vitest');
const TESTER = { username: 'tester', password: 'tester-pass' };
const CASES = [
  { proto: 'svn', repo: 'alpha', url: 'svn://127.0.0.1:13690/alpha/trunk', trust: false },
  { proto: 'https', repo: 'beta', url: 'https://127.0.0.1:18443/svn/beta/trunk', trust: true },
] as const;

const exe = findSvnExe().path;
const ports = [13690, 18443];
const up =
  spawnSync(process.execPath, ['-e', `const n=require('net');let ok=0;for(const p of ${JSON.stringify(ports)}){const s=n.connect({host:'127.0.0.1',port:p,timeout:1500});s.on('connect',()=>{s.destroy();if(++ok===${ports.length})process.exit(0)});s.on('timeout',()=>process.exit(1));s.on('error',()=>process.exit(1));}`], { timeout: 10_000 }).status === 0;
const enabled = !!exe && up;
if (!enabled) console.warn('[test:svn] compare-fetch tests SKIPPED: servers or svn.exe unavailable');

const silent = { info() {}, warn() {}, error() {}, debug() {} };

describe.skipIf(!enabled)('incoming content fetch', () => {
  const raw = new SvnClient(new SvnLocator(() => '', () => ({ path: exe, tried: [] })), undefined, silent, () => 60_000);

  afterAll(() => rmTree(BASE));
  beforeAll(() => {
    const appdata = path.join(BASE, 'appdata');
    fs.mkdirSync(appdata, { recursive: true });
    process.env.APPDATA = appdata;
    fs.mkdirSync(BASE, { recursive: true });
  });

  describe.each(CASES)('$repo over $proto', ({ proto, repo, url, trust }) => {
    const creds: Credentials = { ...TESTER, trustServerCert: trust };
    const client = new Proxy(raw, {
      get(t, k) {
        if (k === 'run') return (a: string[], o = {}) => t.run(a, { ...o, credentials: creds, repoName: undefined });
        if (k === 'info') return (p: string, o = {}) => t.info(p, { ...o, credentials: creds, repoName: undefined });
        return Reflect.get(t, k) as unknown;
      },
    }) as SvnClient;
    const wc1 = path.join(BASE, `${repo}-${proto}-1`);
    const wc2 = path.join(BASE, `${repo}-${proto}-2`);
    const dir = `cmp-${Date.now()}`;
    const run = (cwd: string, ...a: string[]) => client.run(a, { cwd });
    const ft = (target: string, rev: 'HEAD' | 'BASE' | number) => fetchContent(client, { repoName: repo, target, rev });

    it('fetches HEAD and older revisions of a local file', async () => {
      await client.run(['checkout', '--', url, wc1], {});
      fs.mkdirSync(path.join(wc1, dir));
      fs.writeFileSync(path.join(wc1, dir, 'a.txt'), 'one\n');
      await run(wc1, 'add', '--', dir);
      const c1 = await run(wc1, 'commit', '-m', 'r-a', '--', dir);
      const r1 = Number(/Committed revision (\d+)/.exec(c1.text)![1]);
      fs.writeFileSync(path.join(wc1, dir, 'a.txt'), 'one\ntwo\n');
      await run(wc1, 'commit', '-m', 'r-b', '--', dir);
      const file = path.join(wc1, dir, 'a.txt');
      expect((await ft(file, 'HEAD')).text).toBe('one\ntwo\n');
      expect((await ft(file, r1)).text).toBe('one\n');
      expect((await ft(file, 'BASE')).text).toBe('one\ntwo\n');
    });

    it('fetches a remote-added file that has no local copy (resolveCatTarget builds the URL)', async () => {
      await client.run(['checkout', '--', url, wc2], {});
      fs.writeFileSync(path.join(wc2, dir, 'new file.php'), '<?php\necho 1;\n');
      await run(wc2, 'add', '--', path.join(dir, 'new file.php'));
      await run(wc2, 'commit', '-m', 'add new', '--', dir);
      const missing = path.join(wc1, dir, 'new file.php');
      expect(fs.existsSync(missing)).toBe(false);
      const target = await resolveCatTarget(client, repo, missing);
      expect(target).toMatch(/^(svn|https):\/\/.*\/new%20file\.php$/);
      const f = await ft(target, 'HEAD');
      expect(f).toMatchObject({ text: '<?php\necho 1;\n', missing: false, binary: false });
    });

    it('reports a deleted/non-existent path as missing, not an error', async () => {
      const gone = path.join(wc1, dir, 'a.txt');
      await run(wc2, 'update');
      await run(wc2, 'delete', '--', path.join(dir, 'a.txt'));
      await run(wc2, 'commit', '-m', 'del', '--', dir);
      const f = await ft(gone, 'HEAD');
      expect(f).toMatchObject({ missing: true, text: '' });
      expect((await ft(gone, 'BASE')).missing).toBe(false);
    });

    it('detects binary files (NUL bytes and svn:mime-type) and decodes encodings', async () => {
      await run(wc2, 'update');
      const w = (n: string, data: Buffer) => fs.writeFileSync(path.join(wc2, dir, n), data);
      w('bin.dat', Buffer.from([0x50, 0x4b, 0, 3, 4]));
      w('typed.txt', Buffer.from('looks like text\n'));
      w('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom\n')]));
      w('latin.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
      for (const n of ['bin.dat', 'typed.txt', 'bom.txt', 'latin.txt']) await run(wc2, 'add', '--', path.join(dir, n));
      await run(wc2, 'propset', 'svn:mime-type', 'application/octet-stream', '--', path.join(dir, 'typed.txt'));
      await run(wc2, 'commit', '-m', 'bin', '--', dir);
      const u = (n: string) => ft(`${url}/${dir}/${n}`, 'HEAD');
      expect((await u('bin.dat')).binary).toBe(true);
      expect((await u('typed.txt')).binary).toBe(true);
      expect(await u('bom.txt')).toMatchObject({ text: 'bom\n', encoding: 'utf-8-bom', binary: false });
      expect(await u('latin.txt')).toMatchObject({ text: 'caf\u00e9\n', encoding: 'windows-1252' });
    });

    it('last committer (info -r HEAD), blame per line, and update with identical local edits is clean', async () => {
      await run(wc2, 'update');
      await run(wc1, 'update');
      fs.writeFileSync(path.join(wc2, dir, 'u.txt'), 'l1\nl2\n');
      await run(wc2, 'add', '--', path.join(dir, 'u.txt'));
      await run(wc2, 'commit', '-m', 'u1', '--', dir);
      await run(wc1, 'update');
      fs.writeFileSync(path.join(wc2, dir, 'u.txt'), 'l1\nL2 changed\n');
      const c = await run(wc2, 'commit', '-m', 'u2', '--', dir);
      const r2 = Number(/Committed revision (\d+)/.exec(c.text)![1]);
      const f1 = path.join(wc1, dir, 'u.txt');
      const info = parseInfo((await client.run(['info', '-r', 'HEAD', '--', pegSafe(f1)], { xml: true })).text);
      expect(info).toMatchObject({ lastChangedRevision: r2, lastChangedAuthor: 'tester' });
      const lines = parseBlame((await client.run(['blame', '-r', 'HEAD', '--', pegSafe(f1)], { xml: true })).text);
      expect(lines.map((l) => l.author)).toEqual(['tester', 'tester']);
      expect(lines[1].revision).toBe(r2);
      expect(lines[0].revision).toBeLessThan(r2);
      fs.writeFileSync(f1, 'l1\nL2 changed\n');
      const up = await run(wc1, 'update', '--accept', 'postpone', '--', f1);
      expect(parseUpdateConflicts(up.text)).toEqual([]);
      expect((await run(wc1, 'status', '--', f1)).text.trim()).toBe('');
      expect(fs.readFileSync(f1, 'utf8')).toBe('l1\nL2 changed\n');
    });

    it('cleans up', async () => {
      await run(wc2, 'update');
      await run(wc2, 'delete', '--', dir);
      await run(wc2, 'commit', '-m', 'cleanup', '--', dir);
    });
  });
});

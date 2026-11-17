/**
 * Live tests of changelists, the commit executor (selection + unversioned-checked files), locks (two working
 * copies of the same user), svn:needs-lock read-only behaviour, properties (multi-line via -F, recursive) and
 * svn:externals against the local servers. Own scratch checkouts under F:\TrashCache\svn-commit-vitest.
 * Skipped when the servers or svn.exe are missing (python test-env/envctl.py reset).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmTree, runDir } from './scratch';
import { addToChangelist, clearChangelist, listChangelists, removeFromChangelist, renameChangelist } from '../../src/changelist/ops';
import { CommitEntry, buildPlan } from '../../src/commit/selection';
import { commitChangelist, executeCommit } from '../../src/commit/execute';
import { hasNeedsLock, isReadOnlyOnDisk, listLocks, lockOf, lockPaths, unlockPaths } from '../../src/locks/ops';
import { parseExternals, formatExternals } from '../../src/props/externals';
import { applyChanges, deleteProp, getProp, listExternalsUnder, listProps, setProp } from '../../src/props/ops';
import { RepoEntry } from '../../src/repos/model';
import { Credentials, SvnClient } from '../../src/svn/client';
import { findSvnExe } from '../../src/svn/discovery';
import { SvnLocator } from '../../src/svn/locator';

const BASE = runDir('svn-commit-vitest');
const TMP = path.join(BASE, 'tmp');
const TESTER = { username: 'tester', password: 'tester-pass' };
const RUN = `cvt-${Date.now().toString(36)}`;

const CASES = [
  { proto: 'svn', repo: 'alpha', url: 'svn://127.0.0.1:13690/alpha/trunk', trust: false },
  { proto: 'https', repo: 'beta', url: 'https://127.0.0.1:18443/svn/beta/trunk', trust: true },
] as const;

const exe = findSvnExe().path;
const ports = [13690, 18443];
const up =
  spawnSync(process.execPath, ['-e', `const n=require('net');let ok=0;for(const p of ${JSON.stringify(ports)}){const s=n.connect({host:'127.0.0.1',port:p,timeout:1500});s.on('connect',()=>{s.destroy();if(++ok===${ports.length})process.exit(0)});s.on('timeout',()=>process.exit(1));s.on('error',()=>process.exit(1));}`], { timeout: 10_000 }).status === 0;
const enabled = !!exe && up;
if (!enabled) console.warn('[test:svn] commit/locks/props tests SKIPPED: servers or svn.exe unavailable');

const silent = { info() {}, warn() {}, error() {}, debug() {} };

describe.skipIf(!enabled)('commit dialog backend, changelists, locks and properties', () => {
  const raw = new SvnClient(new SvnLocator(() => '', () => ({ path: exe, tried: [] })), undefined, silent, () => 60_000);

  beforeAll(() => {
    const appdata = path.join(BASE, 'appdata');
    fs.mkdirSync(appdata, { recursive: true });
    process.env.APPDATA = appdata;
    fs.mkdirSync(TMP, { recursive: true });
  });

  afterAll(() => {
    rmTree(BASE);
  });

  describe.each(CASES)('$repo over $proto', ({ proto, repo, url, trust }) => {
    const creds: Credentials = { ...TESTER, trustServerCert: trust };
    const client = new Proxy(raw, {
      get(t, k) {
        if (k === 'run') return (a: string[], o = {}) => t.run(a, { ...o, credentials: creds, repoName: undefined });
        if (k === 'status') return (p: string, o = {}) => t.status(p, { ...o, credentials: creds, repoName: undefined });
        return Reflect.get(t, k) as unknown;
      },
    }) as SvnClient;
    const mk = (tag: string): RepoEntry => ({ name: repo, serverUrl: url, localFolder: path.join(BASE, `${repo}-${proto}-${tag}`), ...TESTER, trustServerCert: trust });
    const A = mk('a');
    const B = mk('b');
    const cA = { client, repo: A, tmpDir: path.join(BASE, 'tmp') };
    const cB = { client, repo: B, tmpDir: path.join(BASE, 'tmp') };
    const dirName = `${RUN}-${proto}`;
    // Working copies are checkouts of a private folder, so the shared trunk is never checked out in full.
    const dirA = A.localFolder;
    const dirB = B.localFolder;
    const fA = (n: string): string => path.join(dirA, n);
    const fB = (n: string): string => path.join(dirB, n);
    const svn = async (c: { repo: RepoEntry }, ...args: string[]) => client.run(args, { cwd: c.repo.localFolder });
    const commitRaw = async (c: { repo: RepoEntry }, msg: string, ...paths: string[]): Promise<void> => void (await svn(c, 'commit', '-m', msg, '--', ...paths));
    const statusOf = async (c: { repo: RepoEntry }, p: string): Promise<string | undefined> => {
      const r = await client.status(p, {});
      return r.entries.find((e) => path.resolve(c.repo.localFolder, e.path).toLowerCase() === path.resolve(p).toLowerCase())?.item;
    };
    const entriesOf = async (c: { repo: RepoEntry }): Promise<CommitEntry[]> => {
      const r = await client.status(c.repo.localFolder, {});
      return r.entries.map((e) => ({ repoName: c.repo.name, path: path.resolve(c.repo.localFolder, e.path), item: e.item, props: e.props, changelist: e.changelist, isDir: false }));
    };
    const logMessage = async (rev: number): Promise<string> => {
      const r = await client.run(['log', '-r', String(rev), '--', url], { cwd: A.localFolder, xml: true });
      return r.text;
    };

    it('checks out two working copies and seeds a test folder', async () => {
      await client.run(['mkdir', '-m', 'commit-test folder', '--', `${url}/${dirName}`], {});
      await client.run(['checkout', '--', `${url}/${dirName}`, A.localFolder], {});
      await client.run(['checkout', '--', `${url}/${dirName}`, B.localFolder], {});
      for (const n of ['f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt', 'f6.txt']) fs.writeFileSync(fA(n), `${n}\nline2\n`);
      await svn(cA, 'add', '--', ...['f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt', 'f6.txt'].map(fA));
      await commitRaw(cA, 'seed', dirA);
      await svn(cB, 'update');
      expect(fs.existsSync(fB('f1.txt'))).toBe(true);
    });

    it('changelists: add, list, rename, commit one, keep, clear', async () => {
      fs.appendFileSync(fA('f1.txt'), 'x\n');
      fs.appendFileSync(fA('f2.txt'), 'x\n');
      await addToChangelist(cA, 'feature one', [fA('f1.txt')]);
      expect((await listChangelists(cA)).get('feature one')?.length).toBe(1);
      const st = (await client.status(A.localFolder, {})).entries;
      expect(st.find((e) => e.path.endsWith('f1.txt'))?.changelist).toBe('feature one');
      expect(st.find((e) => e.path.endsWith('f2.txt'))?.changelist).toBeUndefined();

      expect(await renameChangelist(cA, 'feature one', 'feature-1')).toBe(1);
      const lists = await listChangelists(cA);
      expect(lists.has('feature one')).toBe(false);
      expect(lists.get('feature-1')?.length).toBe(1);

      const rev = await commitChangelist(cA, 'feature-1', { message: 'changelist commit\nsecond line', tmpDir: TMP });
      expect(rev).toBeGreaterThan(0);
      expect(await statusOf(cA, fA('f1.txt'))).toBeUndefined();
      expect(await statusOf(cA, fA('f2.txt'))).toBe('modified');
      expect(await logMessage(rev as number)).toContain('second line');

      await addToChangelist(cA, 'keepme', [fA('f2.txt')]);
      await commitChangelist(cA, 'keepme', { message: 'keep list', tmpDir: TMP, keepChangelists: true });
      expect((await listChangelists(cA)).get('keepme')?.length).toBe(1);
      expect(await clearChangelist(cA, 'keepme')).toBe(1);
      expect((await listChangelists(cA)).size).toBe(0);

      await addToChangelist(cA, 'tmp', [fA('f3.txt')]);
      await removeFromChangelist(cA, [fA('f3.txt')]);
      expect((await listChangelists(cA)).size).toBe(0);
    });

    it('commits only the selected files, adds checked unversioned items, keeps the rest', async () => {
      for (const n of ['f3.txt', 'f4.txt']) fs.appendFileSync(fA(n), 'changed\n');
      await svn(cA, 'delete', '--', fA('f5.txt'));
      fs.writeFileSync(fA('u1.txt'), 'u1');
      fs.writeFileSync(fA('u2.txt'), 'u2');
      fs.mkdirSync(path.join(dirA, 'nd', 'inner'), { recursive: true });
      fs.writeFileSync(path.join(dirA, 'nd', 'x.txt'), 'x');
      fs.writeFileSync(path.join(dirA, 'nd', 'inner', 'y.txt'), 'y');
      fs.writeFileSync(fA('a1.txt'), 'a1');
      await svn(cA, 'add', '--', fA('a1.txt'));

      const entries = await entriesOf(cA);
      const plan = buildPlan(repo, entries, [fA('f3.txt'), fA('f5.txt'), fA('u1.txt'), path.join(dirA, 'nd'), fA('a1.txt')]);
      expect(plan.add.map((p) => path.basename(p)).sort()).toEqual(['nd', 'u1.txt']);
      const msg = 'Commit "dialog" $HOME & more\nüñí multi-line\n\n* star line';
      const r = await executeCommit(cA, plan, { message: msg, tmpDir: TMP });
      expect(r.revision).toBeGreaterThan(0);
      expect(r.targets.some((t) => t.endsWith(path.join('nd', 'inner', 'y.txt')))).toBe(true);

      expect(await statusOf(cA, fA('f3.txt'))).toBeUndefined();
      expect(await statusOf(cA, fA('f4.txt'))).toBe('modified');
      expect(await statusOf(cA, fA('u2.txt'))).toBe('unversioned');
      expect(await statusOf(cA, fA('u1.txt'))).toBeUndefined();
      expect(await statusOf(cA, fA('f5.txt'))).toBeUndefined();
      expect(fs.existsSync(fA('f5.txt'))).toBe(false);

      const listing = (await client.run(['list', '-R', '--', `${url}/${dirName}`], {})).text;
      expect(listing).toContain('u1.txt');
      expect(listing).toContain('nd/inner/y.txt');
      expect(listing).toContain('a1.txt');
      expect(listing).not.toContain('u2.txt');
      expect(listing).not.toContain('f5.txt');
      const log = await logMessage(r.revision as number);
      expect(log).toContain('"dialog" $HOME &amp; more');
      expect(log).toContain('üñí multi-line');
      expect(log).toContain('* star line');
    });

    it('commits a file in a not-yet-committed added folder through the implied parent', async () => {
      fs.mkdirSync(path.join(dirA, 'newdir'));
      fs.writeFileSync(path.join(dirA, 'newdir', 'n1.txt'), 'n1');
      fs.writeFileSync(path.join(dirA, 'newdir', 'n2.txt'), 'n2');
      await svn(cA, 'add', '--', path.join(dirA, 'newdir'));
      const entries = await entriesOf(cA);
      const plan = buildPlan(repo, entries, [path.join(dirA, 'newdir', 'n1.txt')]);
      expect(plan.implied.map((p) => path.basename(p))).toEqual(['newdir']);
      await executeCommit(cA, plan, { message: 'implied parent', tmpDir: TMP });
      expect(await statusOf(cA, path.join(dirA, 'newdir', 'n2.txt'))).toBe('added');
      const listing = (await client.run(['list', '-R', '--', `${url}/${dirName}/newdir`], {})).text;
      expect(listing).toContain('n1.txt');
      expect(listing).not.toContain('n2.txt');
      await commitRaw(cA, 'rest', fA('f4.txt'), path.join(dirA, 'newdir', 'n2.txt'));
    });

    it('leaves no temp files behind', () => {
      expect(fs.readdirSync(TMP)).toEqual([]);
    });

    it('locks: lock, competing lock refused, steal, break, status shows owner', async () => {
      await svn(cB, 'update');
      await lockPaths(cA, [fA('f1.txt')], 'editing f1\nsecond line');
      const v = await lockOf(cA, fA('f1.txt'));
      expect(v.state).toBe('mine');
      expect(v.info?.comment).toContain('editing f1');
      expect(v.info?.owner).toBe('tester');

      // second working copy (same user, different token) cannot lock, and sees the file as locked by another
      await expect(lockPaths(cB, [fB('f1.txt')], 'mine now')).rejects.toThrow();
      expect((await lockOf(cB, fB('f1.txt'))).state).toBe('other');

      // a commit from the second copy is refused while the lock is held
      fs.appendFileSync(fB('f1.txt'), 'from B\n');
      await expect(commitRaw(cB, 'blocked by lock', fB('f1.txt'))).rejects.toThrow();
      await svn(cB, 'revert', '--', fB('f1.txt'));

      await lockPaths(cB, [fB('f1.txt')], 'stolen', true);
      expect((await lockOf(cB, fB('f1.txt'))).state).toBe('mine');
      expect((await lockOf(cA, fA('f1.txt'))).state).toBe('other');
      const locks = await listLocks(cB);
      expect(locks.some((l) => l.path.endsWith('f1.txt') && l.view.state === 'mine')).toBe(true);

      // A breaks B's lock with force
      await unlockPaths(cA, [fA('f1.txt')], true);
      expect((await lockOf(cB, fB('f1.txt'))).state).toBe('stale');
      await unlockPaths(cB, [fB('f1.txt')], true);
      expect((await lockOf(cB, fB('f1.txt'))).state).toBe('none');
      expect(await listLocks(cB)).toEqual([]);
    });

    it('keeps locks on commit only when asked', async () => {
      await lockPaths(cA, [fA('f2.txt'), fA('f4.txt')], 'two files');
      fs.appendFileSync(fA('f2.txt'), 'k\n');
      fs.appendFileSync(fA('f4.txt'), 'k\n');
      let plan = buildPlan(repo, await entriesOf(cA), [fA('f2.txt')]);
      await executeCommit(cA, plan, { message: 'release', tmpDir: TMP });
      expect((await lockOf(cA, fA('f2.txt'))).state).toBe('none');
      plan = buildPlan(repo, await entriesOf(cA), [fA('f4.txt')]);
      await executeCommit(cA, plan, { message: 'keep', tmpDir: TMP, keepLocks: true });
      expect((await lockOf(cA, fA('f4.txt'))).state).toBe('mine');
      await unlockPaths(cA, [fA('f4.txt')]);
    });

    it('needs-lock files are read-only until locked', async () => {
      await setProp(cA, fA('f6.txt'), 'svn:needs-lock', '*', { tmpDir: TMP });
      expect(await getProp(cA, fA('f6.txt'), 'svn:needs-lock')).toBe('*');
      await commitRaw(cA, 'needs-lock', fA('f6.txt'));
      await svn(cB, 'update');
      expect(await hasNeedsLock(cB, fB('f6.txt'))).toBe(true);
      expect(await hasNeedsLock(cB, fB('f1.txt'))).toBe(false);
      expect(isReadOnlyOnDisk(fB('f6.txt'))).toBe(true);
      expect(() => fs.appendFileSync(fB('f6.txt'), 'nope')).toThrow();
      await lockPaths(cB, [fB('f6.txt')], 'lock to edit');
      expect(isReadOnlyOnDisk(fB('f6.txt'))).toBe(false);
      fs.appendFileSync(fB('f6.txt'), 'edited under lock\n');
      await commitRaw(cB, 'edited under lock', fB('f6.txt'));
      expect((await lockOf(cB, fB('f6.txt'))).state).toBe('none');
      expect(isReadOnlyOnDisk(fB('f6.txt'))).toBe(true);
    });

    it('properties: multi-line values via -F, special values, list, delete', async () => {
      const value = 'line one\nline "two" with $VAR & | > <\n  indented\n\n* star\n';
      await setProp(cA, fA('f1.txt'), 'custom:note', value, { tmpDir: TMP });
      expect(await getProp(cA, fA('f1.txt'), 'custom:note')).toBe(value);
      await setProp(cA, fA('f1.txt'), 'svn:executable', '*', { tmpDir: TMP });
      await setProp(cA, fA('f1.txt'), 'svn:keywords', 'Id Date', { tmpDir: TMP });
      const names = (await listProps(cA, fA('f1.txt'))).map((p) => p.name);
      expect(names).toEqual(['custom:note', 'svn:executable', 'svn:keywords']);
      expect(await getProp(cA, fA('f1.txt'), 'svn:executable')).toBe('*');
      await deleteProp(cA, fA('f1.txt'), 'svn:executable');
      expect(await getProp(cA, fA('f1.txt'), 'svn:executable')).toBeUndefined();
      await expect(applyChanges(cA, fA('f1.txt'), false, [{ name: 'svn:ignore', value: 'x' }], TMP)).rejects.toThrow(/cannot be set on a file/);
      await applyChanges(cA, fA('f1.txt'), false, [{ name: 'custom:note' }, { name: 'svn:keywords' }], TMP);
      expect(await listProps(cA, fA('f1.txt'))).toEqual([]);
    });

    it('properties: recursive set and delete on a folder, svn:ignore list', async () => {
      await applyChanges(cA, dirA, true, [{ name: 'custom:tag', value: 'multi\nline\n', recursive: true }], TMP);
      expect(await getProp(cA, fA('f2.txt'), 'custom:tag')).toBe('multi\nline\n');
      expect(await getProp(cA, dirA, 'custom:tag')).toBe('multi\nline\n');
      await applyChanges(cA, dirA, true, [{ name: 'custom:tag', recursive: true }], TMP);
      expect(await getProp(cA, fA('f2.txt'), 'custom:tag')).toBeUndefined();
      await applyChanges(cA, dirA, true, [{ name: 'svn:ignore', value: '*.log\nbuild\n' }], TMP);
      expect(await getProp(cA, dirA, 'svn:ignore')).toBe('*.log\nbuild\n');
      await deleteProp(cA, dirA, 'svn:ignore');
    });

    it('externals: set via -F, round trip, update fetches them', async () => {
      fs.mkdirSync(path.join(dirA, 'ext-src'));
      fs.writeFileSync(path.join(dirA, 'ext-src', 'lib.txt'), 'lib');
      await svn(cA, 'add', '--', path.join(dirA, 'ext-src'));
      await commitRaw(cA, 'external source', path.join(dirA, 'ext-src'));
      const ext = formatExternals([{ url: `^/trunk/${dirName}/ext-src`, dir: 'ext dir' }], []);
      await applyChanges(cA, dirA, true, [{ name: 'svn:externals', value: ext }], TMP);
      const back = parseExternals((await getProp(cA, dirA, 'svn:externals')) ?? '');
      expect(back.defs).toEqual([{ url: `^/trunk/${dirName}/ext-src`, peg: undefined, rev: undefined, dir: 'ext dir' }]);
      const found = await listExternalsUnder(cA, A.localFolder);
      expect(found.some((f) => path.resolve(A.localFolder, f.dir).toLowerCase() === dirA.toLowerCase())).toBe(true);
      await svn(cA, 'update', '--', dirA);
      expect(fs.existsSync(path.join(dirA, 'ext dir', 'lib.txt'))).toBe(true);
      await applyChanges(cA, dirA, true, [{ name: 'svn:externals' }], TMP);
      expect(await getProp(cA, dirA, 'svn:externals')).toBeUndefined();
    });

    it('left no temp files behind', () => {
      expect(fs.readdirSync(TMP)).toEqual([]);
    });
  });
});

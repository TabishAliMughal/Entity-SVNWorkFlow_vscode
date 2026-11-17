/**
 * Live tests of the working-copy operations in src/wc/ops.ts (checkout, relocate, switch, set-depth,
 * revert, cleanup, upgrade, update to revision, move/copy/delete/mkdir, record Explorer renames) against
 * the local servers. Own scratch checkouts under F:\TrashCache\svn-wc-vitest. Skipped when the servers
 * or svn.exe are missing (python test-env/envctl.py reset).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmTree, runDir } from './scratch';
import { RepoEntry } from '../../src/repos/model';
import { Credentials, SvnClient } from '../../src/svn/client';
import { findSvnExe } from '../../src/svn/discovery';
import { SvnLocator } from '../../src/svn/locator';
import { commitPaths, overrideUpdate } from '../../src/ops/svnOps';
import { junkEntries, pairMoves, planRevert, revertable } from '../../src/wc/model';
import * as ops from '../../src/wc/ops';

const BASE = runDir('svn-wc-vitest');
const TESTER = { username: 'tester', password: 'tester-pass' };

const CASES = [
  { proto: 'svn', repo: 'alpha', root: 'svn://127.0.0.1:13690/alpha', alt: 'svn://localhost:13690/alpha', trust: false },
  { proto: 'https', repo: 'beta', root: 'https://127.0.0.1:18443/svn/beta', alt: 'https://localhost:18443/svn/beta', trust: true },
] as const;

const exe = findSvnExe().path;
const ports = [13690, 18443];
const up =
  spawnSync(process.execPath, ['-e', `const n=require('net');let ok=0;for(const p of ${JSON.stringify(ports)}){const s=n.connect({host:'127.0.0.1',port:p,timeout:1500});s.on('connect',()=>{s.destroy();if(++ok===${ports.length})process.exit(0)});s.on('timeout',()=>process.exit(1));s.on('error',()=>process.exit(1));}`], { timeout: 10_000 }).status === 0;
const enabled = !!exe && up;
if (!enabled) console.warn('[test:svn] wc tests SKIPPED: servers or svn.exe unavailable');

const silent = { info() {}, warn() {}, error() {}, debug() {} };

describe.skipIf(!enabled)('working copy operations against local servers', () => {
  const client = new SvnClient(new SvnLocator(() => '', () => ({ path: exe, tried: [] })), undefined, silent, () => 60_000);

  beforeAll(() => {
    const appdata = path.join(BASE, 'appdata');
    fs.mkdirSync(appdata, { recursive: true });
    process.env.APPDATA = appdata;
    fs.mkdirSync(BASE, { recursive: true });
  });
  afterAll(() => rmTree(BASE));

  describe.each(CASES)('$repo over $proto', ({ proto, repo, root, alt, trust }) => {
    const url = `${root}/trunk`;
    const wc = path.join(BASE, `${repo}-${proto}`);
    const sparse = path.join(BASE, `${repo}-${proto}-sparse`);
    const creds: Credentials = { ...TESTER, trustServerCert: trust };
    const entry: RepoEntry = { name: repo, serverUrl: url, localFolder: wc, ...TESTER, trustServerCert: trust };
    const withCreds = new Proxy(client, {
      get(t, k) {
        if (k === 'run') return (a: string[], o = {}) => t.run(a, { ...o, credentials: creds, repoName: undefined });
        if (k === 'info') return (p: string, o = {}) => t.info(p, { ...o, credentials: creds, repoName: undefined });
        if (k === 'status') return (p: string, o = {}) => t.status(p, { ...o, credentials: creds, repoName: undefined });
        return Reflect.get(t, k) as unknown;
      },
    }) as SvnClient;
    const c = { client: withCreds, repo: entry, tmpDir: path.join(BASE, 'tmp') };
    const tag = `wcv-${Date.now().toString(36)}`;
    const dir = path.join(wc, tag);
    const item = async (p: string, target = wc) => (await ops.statusEntries(c, target)).find((e) => path.resolve(e.path).toLowerCase() === path.resolve(p).toLowerCase())?.item;

    it('checks out with credentials (and fails cleanly without them)', async () => {
      const r = await ops.checkout({ client, url, target: wc, depth: 'infinity', credentials: creds });
      expect(r.revision).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(wc, '.svn'))).toBe(true);
      await expect(ops.checkout({ client, url, target: path.join(BASE, `${repo}-${proto}-bad`), depth: 'empty', credentials: { username: 'tester', password: 'wrong', trustServerCert: trust } })).rejects.toMatchObject({ kind: 'auth' });
    });

    it('creates and commits content for the later tests', async () => {
      expect(await ops.mkdirPath(c, dir)).toBe('created');
      await ops.mkdirPath(c, path.join(dir, 'sub1'));
      await ops.mkdirPath(c, path.join(dir, 'sub2'));
      fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
      fs.writeFileSync(path.join(dir, 'sub1', 'f1.txt'), 'f1');
      fs.writeFileSync(path.join(dir, 'sub2', 'f2.txt'), 'f2');
      await withCreds.run(['add', '--force', '--', dir]);
      const rev = await commitPaths(c, [dir], 'wc test content');
      expect(rev).toBeGreaterThan(0);
      fs.appendFileSync(path.join(dir, 'a.txt'), 'two\n');
      expect(await commitPaths(c, [dir], 'wc test second')).toBeGreaterThan(rev!);
    });

    it('set-depth and sparse update', async () => {
      await ops.checkout({ client, url, target: sparse, depth: 'empty', credentials: creds });
      expect(fs.readdirSync(sparse).filter((n) => n !== '.svn')).toEqual([]);
      const sc = { client: withCreds, repo: { ...entry, localFolder: sparse }, tmpDir: path.join(BASE, 'tmp') };
      await ops.setDepth(sc, sparse, 'immediates');
      expect(fs.existsSync(path.join(sparse, tag))).toBe(true);
      await ops.setDepth(sc, path.join(sparse, tag), 'empty');
      expect(fs.readdirSync(path.join(sparse, tag))).toEqual([]);
      const kids = await ops.remoteChildren(sc, path.join(sparse, tag));
      expect(kids.map((k) => k.name).sort()).toEqual(['a.txt', 'sub1', 'sub2']);
      await ops.includeChildren(sc, path.join(sparse, tag), ['sub1']);
      expect(fs.existsSync(path.join(sparse, tag, 'sub1', 'f1.txt'))).toBe(true);
      expect(fs.existsSync(path.join(sparse, tag, 'sub2'))).toBe(false);
      await ops.setDepth(sc, path.join(sparse, tag, 'sub1'), 'exclude');
      expect(fs.existsSync(path.join(sparse, tag, 'sub1'))).toBe(false);
      await ops.setDepth(sc, sparse, 'infinity');
      expect(fs.existsSync(path.join(sparse, tag, 'sub2', 'f2.txt'))).toBe(true);
    });

    it('updates a file to an older revision and back', async () => {
      const a = path.join(dir, 'a.txt');
      const info = await withCreds.info(a);
      const r = await ops.updateToRevision(c, [a], String((info.lastChangedRevision ?? 2) - 1));
      expect(r.conflicts).toEqual([]);
      expect(fs.readFileSync(a, 'utf8')).toBe('one\n');
      await ops.updateToRevision(c, [a], 'HEAD');
      expect(fs.readFileSync(a, 'utf8')).toBe('one\ntwo\n');
    });

    it('revert: selection plan, partial revert, missing file, added item', async () => {
      const a = path.join(dir, 'a.txt');
      const f1 = path.join(dir, 'sub1', 'f1.txt');
      fs.appendFileSync(a, 'local\n');
      fs.rmSync(f1);
      const added = path.join(dir, 'new.txt');
      fs.writeFileSync(added, 'n');
      await ops.mkdirPath(c, path.join(dir, 'sub3'));
      fs.writeFileSync(path.join(dir, 'sub3', 'x.txt'), 'x');
      await withCreds.run(['add', '--', added, path.join(dir, 'sub3', 'x.txt')]);
      const cands = revertable(await ops.statusEntries(c, dir)).map((e) => ({ path: e.path, item: e.item, props: e.props, isDir: ops.isDirSafe(e.path) || e.item === 'missing' ? ops.isDirSafe(e.path) : false }));
      expect(cands.map((x) => `${path.basename(x.path)}:${x.item}`).sort()).toEqual(['a.txt:modified', 'f1.txt:missing', 'new.txt:added', 'sub3:added', 'x.txt:added']);

      // only a.txt selected
      const sel = new Set([path.resolve(a).toLowerCase()]);
      const plan = planRevert(cands, sel);
      expect(plan).toEqual([{ path: a, recursive: false }]);
      await ops.revertSteps(c, plan);
      expect(fs.readFileSync(a, 'utf8')).toBe('one\ntwo\n');
      expect(await item(f1)).toBe('missing');

      // everything: folder sub3 recursive covers x.txt
      const all = revertable(await ops.statusEntries(c, dir)).map((e) => ({ path: e.path, item: e.item, isDir: ops.isDirSafe(e.path) }));
      const full = planRevert(all, new Set(all.map((x) => path.resolve(x.path).toLowerCase())));
      await ops.revertSteps(c, full);
      expect(fs.existsSync(f1)).toBe(true);
      expect(await item(added)).toBe('unversioned');
      expect(await item(path.join(dir, 'sub3'))).toBe('unversioned');
      fs.rmSync(added);
      fs.rmSync(path.join(dir, 'sub3'), { recursive: true });
    });

    it('cleanup: lists and removes unversioned / ignored items, breaks repository locks, vacuum', async () => {
      fs.writeFileSync(path.join(dir, 'junk.tmp'), 'j');
      fs.mkdirSync(path.join(dir, 'junkdir'));
      fs.writeFileSync(path.join(dir, 'junkdir', 'in.txt'), 'j');
      fs.writeFileSync(path.join(dir, 'ign.log'), 'i');
      await withCreds.run(['propset', 'svn:ignore', '*.log', dir]);
      const un = await ops.junkUnder(c, [dir], { unversioned: true, ignored: false });
      expect(un.map((e) => path.basename(e.path)).sort()).toEqual(['junk.tmp', 'junkdir']);
      const both = await ops.junkUnder(c, [dir], { unversioned: true, ignored: true });
      expect(both.map((e) => path.basename(e.path)).sort()).toEqual(['ign.log', 'junk.tmp', 'junkdir']);
      expect(junkEntries(both, { unversioned: false, ignored: true }).map((e) => path.basename(e.path))).toEqual(['ign.log']);
      await ops.removePaths(c, both.map((e) => e.path));
      expect(fs.existsSync(path.join(dir, 'junkdir'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'ign.log'))).toBe(false);
      await withCreds.run(['revert', '--', dir]);

      const a = path.join(dir, 'a.txt');
      await withCreds.run(['lock', '-m', 'test lock', '--', a]);
      expect(await ops.breakRepoLocks(c, [dir], true)).toEqual([a]);
      expect(await ops.breakRepoLocks(c, [dir])).toEqual([a]);
      expect(await ops.breakRepoLocks(c, [dir], true)).toEqual([]);
      await ops.cleanup(c, [wc], { vacuumPristines: true, includeExternals: false });
      await ops.upgradeWc(c, wc);
    });

    it('file operations: mkdir, copy, move, delete, over history', async () => {
      const a = path.join(dir, 'a.txt');
      const cp = path.join(dir, 'copy', 'a-copy.txt');
      await ops.copyPath(c, a, cp);
      expect(await item(cp)).toBe('added');
      expect((await ops.statusEntries(c, cp))[0].copied).toBe(true);
      const mv = path.join(dir, 'moved', 'deep', 'a-moved.txt');
      await ops.movePath(c, cp, mv);
      expect(fs.existsSync(cp)).toBe(false);
      expect(await item(mv)).toBe('added');
      await ops.movePath(c, a, path.join(dir, 'renamed.txt'));
      expect(fs.existsSync(a)).toBe(false);
      expect(await item(a)).toBe('deleted');
      await ops.deletePaths(c, [path.join(dir, 'sub2')]);
      expect(fs.existsSync(path.join(dir, 'sub2'))).toBe(false);
      // existing unversioned folder is added by mkdir
      fs.mkdirSync(path.join(dir, 'pre'));
      expect(await ops.mkdirPath(c, path.join(dir, 'pre'))).toBe('added');
      expect(await item(path.join(dir, 'pre'))).toBe('added');
      const rev = await commitPaths(c, [dir], 'wc file ops');
      expect(rev).toBeGreaterThan(0);
      const log = await withCreds.run(['log', '-v', '-r', String(rev), '--', path.join(dir, 'renamed.txt')]);
      expect(log.text).toMatch(/A .*renamed\.txt \(from .*a\.txt:\d+\)/);
    });

    it('records Explorer-style renames and deletes as svn move / delete', async () => {
      const f = path.join(dir, 'sub1', 'f1.txt');
      const g = path.join(dir, 'sub1', 'f1-renamed.txt');
      fs.renameSync(f, g);
      expect(await ops.isMissing(c, f)).toBe(true);
      expect(await ops.isUnversionedPath(c, g)).toBe(true);
      await ops.recordMove(c, f, g);
      expect(await item(g)).toBe('added');
      expect((await ops.statusEntries(c, g))[0].copied).toBe(true);
      expect(await item(f)).toBe('deleted');

      // folder rename
      const d1 = path.join(dir, 'renamed.txt');
      const d2 = path.join(dir, 'zzz', 'renamed2.txt');
      fs.mkdirSync(path.dirname(d2));
      fs.renameSync(d1, d2);
      await ops.recordMove(c, d1, d2);
      expect(await item(d2)).toBe('added');

      // scan: moved + changed-name file pairing and plain delete
      const h = path.join(dir, 'pre', 'zz.txt');
      fs.writeFileSync(h, 'zz-content');
      await withCreds.run(['add', '--', h]);
      await commitPaths(c, [dir], 'wc scan prep');
      fs.renameSync(h, path.join(dir, 'zzz', 'moved-zz.txt'));
      const gone = path.join(dir, 'sub1', 'f1-renamed.txt');
      await commitPaths(c, [dir], 'wc commit renames');
      fs.rmSync(gone);
      const scan = await ops.scanMissing(c, wc);
      expect(scan.plan.moves).toEqual([{ from: h, to: path.join(dir, 'zzz', 'moved-zz.txt') }]);
      expect(scan.plan.deletes).toEqual([gone]);
      await ops.recordMove(c, h, path.join(dir, 'zzz', 'moved-zz.txt'));
      await ops.deletePaths(c, [gone]);
      expect(await item(gone)).toBe('deleted');
      expect(pairMoves([], [])).toEqual({ moves: [], deletes: [] });
    });

    it('switches to a branch created with svn copy, lists branches, switches back', async () => {
      const branch = `${root}/branches/${tag}`;
      await withCreds.run(['copy', '--parents', '-m', 'wc test branch', '--', url, branch]);
      const info = await ops.wcInfo(c);
      expect(info.repositoryRoot.replace(/\/+$/, '')).toBe(root);
      expect(await ops.listRepoFolder(c, info.repositoryRoot, 'branches')).toContain(tag);
      expect(await ops.listRepoFolder(c, info.repositoryRoot, 'definitely-not-here')).toEqual([]);
      await commitPaths(c, [dir], 'wc commit before switch');
      const r = await ops.switchTo(c, wc, branch);
      expect(r.conflicts).toEqual([]);
      expect((await ops.wcInfo(c)).url).toBe(branch);
      await ops.switchTo(c, wc, url);
      expect((await ops.wcInfo(c)).url).toBe(url);
    });

    it('commit message with non-ASCII text and emoji survives (UTF-8 message file)', async () => {
      const f = path.join(dir, 'msg.txt');
      fs.writeFileSync(f, 'm');
      await withCreds.run(['add', '--', f]);
      const msg = 'Fix: café über 中文 \u{1F680} done';
      const rev = await commitPaths(c, [f], msg);
      expect(rev).toBeGreaterThan(0);
      const log = await withCreds.run(['log', '--xml', '-r', String(rev), '--', f]);
      expect(log.stdout.toString('utf8')).toContain(`<msg>${msg}</msg>`);
      expect(fs.readdirSync(path.join(BASE, 'tmp'))).toEqual([]);
    });

    it('Override and Update survives a local add colliding with a server add', async () => {
      const sc = { client: withCreds, repo: { ...entry, localFolder: sparse }, tmpDir: path.join(BASE, 'tmp') };
      const name = `obst-${tag}.txt`;
      fs.writeFileSync(path.join(dir, name), 'local');
      await withCreds.run(['add', '--', path.join(dir, name)]);
      const other = path.join(sparse, tag, name);
      fs.writeFileSync(other, 'server');
      await withCreds.run(['add', '--', other]);
      await commitPaths(sc, [other], 'server add');
      const r = await overrideUpdate(c, [dir], { removeUnversioned: false });
      expect(r.revision).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(dir, name))).toBe(true);
      expect(await item(path.join(dir, name))).not.toBe('unversioned');
    });

    it('relocates to the same repository under another host name', async () => {
      const altUrl = `${alt}/trunk`;
      const { oldUrl } = await ops.relocate(c, altUrl);
      expect(oldUrl).toBe(url);
      expect((await ops.wcInfo(c)).url).toBe(altUrl);
      await ops.relocate(c, url);
      expect((await ops.wcInfo(c)).url).toBe(url);
      await expect(ops.relocate(c, `${root}-other/trunk`)).rejects.toBeTruthy();
    });
  });
});

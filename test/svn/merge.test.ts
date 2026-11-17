/**
 * Live tests of merge, branch/tag and export (tasks 23-25, 45) against the local servers. Each run works in its
 * own project folder (mt-<timestamp>/trunk|branches|tags) so concurrent suites never interfere, with checkouts under
 * F:\TrashCache\svn-merge-vitest. Skipped when servers or svn.exe are missing.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmTree, runDir } from './scratch';
import { detectLayout } from '../../src/branch/model';
import { createRef, deleteUrl, listDirs, urlExists } from '../../src/branch/ops';
import { runExport } from '../../src/export/ops';
import { parseRevSpec } from '../../src/merge/model';
import { localChangeCount, logOfRevs, mergeinfoRevs, runMerge } from '../../src/merge/ops';
import { parseLog } from '../../src/svn/xml';
import type { RepoEntry } from '../../src/repos/model';
import { Credentials, SvnClient } from '../../src/svn/client';
import { findSvnExe } from '../../src/svn/discovery';
import { SvnLocator } from '../../src/svn/locator';

const BASE = runDir('svn-merge-vitest');
const TESTER = { username: 'tester', password: 'tester-pass' };

const CASES = [
  { proto: 'svn', repo: 'alpha', root: 'svn://127.0.0.1:13690/alpha', trust: false },
  { proto: 'https', repo: 'beta', root: 'https://127.0.0.1:18443/svn/beta', trust: true },
] as const;

const exe = findSvnExe().path;
const ports = [13690, 18443];
const up =
  spawnSync(process.execPath, ['-e', `const n=require('net');let ok=0;for(const p of ${JSON.stringify(ports)}){const s=n.connect({host:'127.0.0.1',port:p,timeout:1500});s.on('connect',()=>{s.destroy();if(++ok===${ports.length})process.exit(0)});s.on('timeout',()=>process.exit(1));s.on('error',()=>process.exit(1));}`], { timeout: 10_000 }).status === 0;
const enabled = !!exe && up;
if (!enabled) console.warn('[test:svn] merge tests SKIPPED: servers or svn.exe unavailable');

const silent = { info() {}, warn() {}, error() {}, debug() {} };

describe.skipIf(!enabled)('merge, branch/tag and export against local servers', () => {
  const raw = new SvnClient(new SvnLocator(() => '', () => ({ path: exe, tried: [] })), undefined, silent, () => 60_000);

  beforeAll(() => {
    const appdata = path.join(BASE, 'appdata');
    fs.mkdirSync(appdata, { recursive: true });
    process.env.APPDATA = appdata;
    fs.mkdirSync(BASE, { recursive: true });
  });
  afterAll(() => {
    rmTree(BASE);
  });

  describe.each(CASES)('$repo over $proto', ({ proto, repo, root, trust }) => {
    const creds: Credentials = { ...TESTER, trustServerCert: trust };
    const client = new Proxy(raw, {
      get(t, k) {
        if (k === 'run') return (a: string[], o = {}) => t.run(a, { ...o, credentials: creds, repoName: undefined });
        if (k === 'info') return (p: string, o = {}) => t.info(p, { ...o, credentials: creds, repoName: undefined });
        if (k === 'status') return (p: string, o = {}) => t.status(p, { ...o, credentials: creds, repoName: undefined });
        return Reflect.get(t, k) as unknown;
      },
    }) as SvnClient;
    const project = `mt-${Date.now()}`;
    const proj = `${root}/${project}`;
    const dirOf = (n: string): string => path.join(BASE, `${repo}-${proto}`, n);
    const entry = (wc: string): RepoEntry => ({ name: repo, serverUrl: proj, localFolder: wc });
    const mc = (wc: string, signal?: AbortSignal) => ({ client, repo: entry(wc), cwd: wc, signal });
    const bc = (wc: string) => ({ client, repo: entry(wc), tmpDir: path.join(BASE, 'tmp') });
    const sh = async (args: string[], cwd?: string): Promise<string> => (await client.run(args, { cwd })).text;
    const commit = async (wc: string, msg: string): Promise<number> => {
      const t = await sh(['commit', '-m', msg], wc);
      return Number(/Committed revision (\d+)/.exec(t)?.[1]);
    };
    const w = (wc: string, f: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(wc, f)), { recursive: true });
      fs.writeFileSync(path.join(wc, f), text);
    };
    const r = (wc: string, f: string): string => fs.readFileSync(path.join(wc, f), 'utf8');

    const trunkWc = dirOf('trunk');
    const rev: Record<string, number> = {};

    afterAll(async () => {
      await client.run(['delete', '-m', 'cleanup merge test', '--', proj], {}).catch(() => undefined);
    });

    it('creates the layout and the first trunk revision; detects the layout', async () => {
      await client.run(['mkdir', '--parents', '-m', 'layout', '--', `${proj}/trunk`, `${proj}/branches`, `${proj}/tags`], {});
      await client.run(['checkout', '-q', '--', `${proj}/trunk`, trunkWc], {});
      w(trunkWc, 'a.txt', 'line1\nline2\nline3\n');
      w(trunkWc, 'b.txt', 'bee\n');
      w(trunkWc, 'd/c.txt', 'c1\n');
      await sh(['add', '--force', '.'], trunkWc);
      rev.t1 = await commit(trunkWc, 't1 initial');
      const info = await client.info(trunkWc);
      const l = detectLayout(info.repositoryRoot, info.url);
      expect(l.kind).toBe('trunk');
      expect(l.base).toBe(proj);
      expect(l.branches).toBe(`${proj}/branches`);
      expect(await urlExists({ client, repo: entry(trunkWc) }, l.trunk)).toBe(true);
      expect(await urlExists({ client, repo: entry(trunkWc) }, `${proj}/nope`)).toBe(false);
      expect(await listDirs({ client, repo: entry(trunkWc) }, l.branches)).toEqual([]);
    });

    it('creates branches from HEAD, from a revision and from the working copy (with a warning-worthy local change)', async () => {
      const c = bc(trunkWc);
      const a = await createRef(c, { kind: 'url', url: `${proj}/trunk`, rev: 'HEAD' }, `${proj}/branches/b1`, 'branch b1 ü 日本');
      expect(a.revision).toBeGreaterThan(rev.t1);
      const log = parseLog((await client.run(['log', '-l', '1', '--xml', '--', `${proj}/branches/b1`], {})).text);
      expect(log[0].message).toBe('branch b1 ü 日本');

      await createRef(c, { kind: 'url', url: `${proj}/trunk`, rev: rev.t1 }, `${proj}/branches/b2`, 'branch b2 at t1');
      // WC -> URL copy includes the uncommitted edit
      w(trunkWc, 'a.txt', 'line1\nline2\nline3\nLOCAL\n');
      expect(await localChangeCount({ client, repo: entry(trunkWc) }, trunkWc)).toBe(1);
      await createRef(c, { kind: 'wc', path: trunkWc }, `${proj}/branches/bwc`, 'branch from wc');
      expect(await sh(['cat', '--', `${proj}/branches/bwc/a.txt`])).toContain('LOCAL');
      await sh(['revert', 'a.txt'], trunkWc);
      expect(await localChangeCount({ client, repo: entry(trunkWc) }, trunkWc)).toBe(0);
      expect((await listDirs({ client, repo: entry(trunkWc) }, `${proj}/branches`)).sort()).toEqual(['b1', 'b2', 'bwc']);
    });

    it('prepares trunk changes and checks the branch working copy', async () => {
      w(trunkWc, 'a.txt', 'line1 trunk\nline2\nline3\n');
      w(trunkWc, 'new.txt', 'new\n');
      await sh(['add', 'new.txt'], trunkWc);
      await sh(['delete', 'b.txt'], trunkWc);
      rev.t2 = await commit(trunkWc, 't2 edit a, add new, delete b');
      w(trunkWc, 'd/c.txt', 'c1\nc2\n');
      rev.t3 = await commit(trunkWc, 't3 edit c');
      await client.run(['checkout', '-q', '--', `${proj}/branches/b1`, dirOf('b1')], {});
    });

    it('lists eligible revisions with log messages and previews a sync merge without touching the working copy', async () => {
      const b1 = dirOf('b1');
      expect(await mergeinfoRevs(mc(b1), 'eligible', `${proj}/trunk`, '.')).toEqual([rev.t2, rev.t3]);
      expect(await mergeinfoRevs(mc(b1), 'merged', `${proj}/trunk`, '.')).toEqual([]);
      const log = await logOfRevs(mc(b1), `${proj}/trunk`, [rev.t2, rev.t3]);
      expect(log.map((e) => e.message)).toEqual(['t3 edit c', 't2 edit a, add new, delete b']);

      const dry = await runMerge(mc(b1), { kind: 'sync', source: `${proj}/trunk`, target: '.', dryRun: true });
      expect(dry.changes.map((x) => `${x.action}:${x.path.replace(/\\/g, '/')}`).sort()).toEqual(['A:new.txt', 'D:b.txt', 'U:a.txt', 'U:d/c.txt']);
      expect(dry.conflicts).toEqual([]);
      expect(await localChangeCount(mc(b1), '.')).toBe(0);
      expect(r(b1, 'b.txt')).toBe('bee\n');
    });

    it('cherry-picks one revision, then records another with --record-only', async () => {
      const b1 = dirOf('b1');
      const spec = parseRevSpec(String(rev.t3));
      expect('spec' in spec && spec.spec).toBe(String(rev.t3));
      const res = await runMerge(mc(b1), { kind: 'range', source: `${proj}/trunk`, target: '.', revs: String(rev.t3) });
      expect(res.conflicts).toEqual([]);
      expect(res.changes.map((x) => x.path.replace(/\\/g, '/'))).toEqual(['d/c.txt']);
      expect(res.recordedMergeinfo).toBe(true);
      expect(r(b1, 'd/c.txt')).toBe('c1\nc2\n');
      expect(r(b1, 'a.txt')).toBe('line1\nline2\nline3\n');
      expect(await mergeinfoRevs(mc(b1), 'merged', `${proj}/trunk`, '.')).toEqual([rev.t3]);
      expect(await mergeinfoRevs(mc(b1), 'eligible', `${proj}/trunk`, '.')).toEqual([rev.t2]);
      await commit(b1, 'merge t3');
      await sh(['update', '-q'], b1);

      const rec = await runMerge(mc(b1), { kind: 'range', source: `${proj}/trunk`, target: '.', revs: String(rev.t2), recordOnly: true });
      expect(rec.changes).toEqual([]);
      expect(rec.recordedMergeinfo).toBe(true);
      expect(r(b1, 'a.txt')).toBe('line1\nline2\nline3\n');
      expect(fs.existsSync(path.join(b1, 'new.txt'))).toBe(false);
      expect(await mergeinfoRevs(mc(b1), 'eligible', `${proj}/trunk`, '.')).toEqual([]);
      await commit(b1, 'record t2');
    });

    it('syncs trunk into a branch, then reintegrates the branch into trunk', async () => {
      const b2 = dirOf('b2');
      await client.run(['checkout', '-q', '--', `${proj}/branches/b2`, b2], {});
      const sync = await runMerge(mc(b2), { kind: 'sync', source: `${proj}/trunk`, target: '.' });
      expect(sync.conflicts).toEqual([]);
      expect(summarizeOk(sync.changes.length)).toBe(true);
      expect(r(b2, 'a.txt')).toBe('line1 trunk\nline2\nline3\n');
      expect(fs.existsSync(path.join(b2, 'b.txt'))).toBe(false);
      expect(fs.existsSync(path.join(b2, 'new.txt'))).toBe(true);
      expect(await mergeinfoRevs(mc(b2), 'eligible', `${proj}/trunk`, '.')).toEqual([]);
      await commit(b2, 'sync trunk into b2');
      w(b2, 'feature.txt', 'feature\n');
      await sh(['add', 'feature.txt'], b2);
      await commit(b2, 'feature on b2');

      await sh(['update', '-q'], trunkWc);
      const re = await runMerge(mc(trunkWc), { kind: 'reintegrate', source: `${proj}/branches/b2`, target: '.' });
      expect(re.conflicts).toEqual([]);
      expect(re.changes.map((x) => x.path)).toContain('feature.txt');
      expect(r(trunkWc, 'feature.txt')).toBe('feature\n');
      await commit(trunkWc, 'reintegrate b2');
    });

    it('reports a conflict and honours the accept policy', async () => {
      const c = bc(trunkWc);
      await createRef(c, { kind: 'url', url: `${proj}/trunk`, rev: 'HEAD' }, `${proj}/branches/b3`, 'branch b3');
      const b3 = dirOf('b3');
      await client.run(['checkout', '-q', '--', `${proj}/branches/b3`, b3], {});
      w(b3, 'a.txt', 'line1 BRANCH\nline2\nline3\n');
      await commit(b3, 'edit a on b3');
      await sh(['update', '-q'], b3);
      await sh(['update', '-q'], trunkWc);
      w(trunkWc, 'a.txt', 'line1 TRUNK\nline2\nline3\n');
      rev.t4 = await commit(trunkWc, 'edit a on trunk');

      const res = await runMerge(mc(b3), { kind: 'sync', source: `${proj}/trunk`, target: '.' });
      expect(res.conflicts.map((x) => x.replace(/\\/g, '/'))).toEqual(['a.txt']);
      expect(r(b3, 'a.txt')).toContain('<<<<<<<');
      expect(res.changes.some((x) => x.action === 'C')).toBe(true);
      await sh(['revert', '-R', '.'], b3);

      const mine = await runMerge(mc(b3), { kind: 'sync', source: `${proj}/trunk`, target: '.', accept: 'mine-conflict' });
      expect(mine.conflicts).toEqual([]);
      expect(r(b3, 'a.txt')).toBe('line1 BRANCH\nline2\nline3\n');
      await sh(['revert', '-R', '.'], b3);
      const theirs = await runMerge(mc(b3), { kind: 'sync', source: `${proj}/trunk`, target: '.', accept: 'theirs-full' });
      expect(theirs.conflicts).toEqual([]);
      expect(r(b3, 'a.txt')).toBe('line1 TRUNK\nline2\nline3\n');
    });

    it('creates a tag from a revision, lists it and deletes a branch', async () => {
      const c = bc(trunkWc);
      const t = await createRef(c, { kind: 'url', url: `${proj}/trunk`, rev: rev.t1 }, `${proj}/tags/v1`, 'tag v1');
      expect(t.revision).toBeGreaterThan(0);
      expect(await listDirs({ client, repo: entry(trunkWc) }, `${proj}/tags`)).toEqual(['v1']);
      expect(await sh(['cat', '--', `${proj}/tags/v1/b.txt`])).toBe('bee\n');
      // nested ref names get their parents created
      await createRef(c, { kind: 'url', url: `${proj}/trunk`, rev: 'HEAD' }, `${proj}/branches/feature/x`, 'nested');
      expect(await listDirs({ client, repo: entry(trunkWc) }, `${proj}/branches/feature`)).toEqual(['x']);

      const d = await deleteUrl(c, `${proj}/branches/b1`, 'delete b1');
      expect(d.revision).toBeGreaterThan(0);
      expect(await urlExists({ client, repo: entry(trunkWc) }, `${proj}/branches/b1`)).toBe(false);
      expect(await listDirs({ client, repo: entry(trunkWc) }, `${proj}/branches`)).not.toContain('b1');
    });

    it('exports a working copy (with local changes) and a URL at a revision', async () => {
      const out = path.join(BASE, `${repo}-${proto}-export`);
      fs.mkdirSync(out, { recursive: true });
      w(trunkWc, 'a.txt', 'line1 TRUNK\nline2\nline3\nLOCAL EDIT\n');
      w(trunkWc, 'untracked.txt', 'x');
      const wcOut = path.join(out, 'wc');
      const e1 = await runExport({ client, repo: entry(trunkWc) }, { source: trunkWc, dest: wcOut, depth: 'infinity', eol: 'default', ignoreExternals: false, force: false });
      expect(e1.items).toBeGreaterThan(2);
      expect(fs.existsSync(path.join(wcOut, '.svn'))).toBe(false);
      expect(r(wcOut, 'a.txt')).toContain('LOCAL EDIT');
      expect(fs.existsSync(path.join(wcOut, 'd', 'c.txt'))).toBe(true);
      await sh(['revert', 'a.txt'], trunkWc);

      const urlOut = path.join(out, 'url');
      const e2 = await runExport({ client, repo: entry(trunkWc) }, { source: `${proj}/trunk@${rev.t1}`, dest: urlOut, rev: rev.t1, depth: 'infinity', eol: 'default', ignoreExternals: true, force: false });
      expect(e2.revision).toBe(rev.t1);
      expect(r(urlOut, 'a.txt')).toBe('line1\nline2\nline3\n');
      expect(fs.existsSync(path.join(urlOut, 'b.txt'))).toBe(true);

      // existing destination needs force
      await expect(runExport({ client, repo: entry(trunkWc) }, { source: `${proj}/trunk`, dest: urlOut, depth: 'infinity', eol: 'default', ignoreExternals: false, force: false })).rejects.toThrow();
      await runExport({ client, repo: entry(trunkWc) }, { source: `${proj}/trunk`, dest: urlOut, rev: 'HEAD', depth: 'infinity', eol: 'default', ignoreExternals: false, force: true });
      expect(r(urlOut, 'a.txt')).toBe('line1 TRUNK\nline2\nline3\n');
      expect(fs.existsSync(path.join(urlOut, 'b.txt'))).toBe(true);

      // depth files + native eol
      const flat = path.join(out, 'flat');
      await runExport({ client, repo: entry(trunkWc) }, { source: `${proj}/trunk`, dest: flat, rev: 'HEAD', depth: 'files', eol: 'CRLF', ignoreExternals: false, force: false });
      expect(fs.existsSync(path.join(flat, 'a.txt'))).toBe(true);
      expect(fs.existsSync(path.join(flat, 'd'))).toBe(false);

      // a single file
      const one = path.join(out, 'one.txt');
      await runExport({ client, repo: entry(trunkWc) }, { source: `${proj}/trunk/a.txt`, dest: one, rev: 'HEAD', depth: 'infinity', eol: 'default', ignoreExternals: false, force: false });
      expect(fs.readFileSync(one, 'utf8')).toBe('line1 TRUNK\nline2\nline3\n');
    });
  });
});

function summarizeOk(n: number): boolean {
  return n >= 3;
}

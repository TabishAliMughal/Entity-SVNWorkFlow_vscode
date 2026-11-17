/**
 * Live scale tests for blame, history, revert/update, merge, branch/tag and export (task 26): a file of 60k lines
 * (about 3.6 MB) and 300+ revisions. Own project folder (sc-<timestamp>) in alpha over svn://, checkout under
 * F:\TrashCache\svn-scale-vitest. Skipped when the server or svn.exe is missing.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmTree, runDir } from './scratch';
import { BlameCache, mapBlameToText } from '../../src/blame/model';
import { loadBlame } from '../../src/blame/service';
import { createRef } from '../../src/branch/ops';
import { diffLines } from '../../src/diff';
import { runExport } from '../../src/export/ops';
import { LogFilter, loadPage } from '../../src/history/model';
import { HistoryTarget, catAtRevision, logBatchFetcher, revertChangesOfRevision, revertToRevision, targetInfo, updateToRevision } from '../../src/history/service';
import { localChangeCount, logOfRevs, mergeinfoRevs, runMerge } from '../../src/merge/ops';
import type { RepoEntry } from '../../src/repos/model';
import { Credentials, SvnClient } from '../../src/svn/client';
import { findSvnExe } from '../../src/svn/discovery';
import { SvnLocator } from '../../src/svn/locator';

const BASE = runDir('svn-scale-vitest');
const ROOT = 'svn://127.0.0.1:13690/alpha';
const REPO = 'alpha';
const MANY = 310;
const BIG_LINES = 60_000;
const SLOTS = MANY * 3;
// revision i rewrites line 3(i-1)+1: far enough apart that reverse merges of single revisions never conflict
const slotOf = (i: number): number => 3 * (i - 1) + 1;

const exe = findSvnExe().path;
const up =
  spawnSync(process.execPath, ['-e', "const s=require('net').connect({host:'127.0.0.1',port:13690,timeout:1500});s.on('connect',()=>process.exit(0));s.on('timeout',()=>process.exit(1));s.on('error',()=>process.exit(1));"], { timeout: 10_000 }).status === 0;
const enabled = !!exe && up;
if (!enabled) console.warn('[test:svn] scale tests SKIPPED: server or svn.exe unavailable');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const bigText = (tag: string): string => {
  const out: string[] = [];
  for (let i = 0; i < BIG_LINES; i++) out.push(`${tag} ${String(i).padStart(6, '0')} lorem ipsum dolor sit amet consectetur adipiscing`);
  return out.join('\n') + '\n';
};

describe.skipIf(!enabled)('scale: large file and many revisions', () => {
  const raw = new SvnClient(new SvnLocator(() => '', () => ({ path: exe, tried: [] })), undefined, silent, () => 120_000);
  const creds: Credentials = { username: 'tester', password: 'tester-pass', trustServerCert: false };
  const client = new Proxy(raw, {
    get(t, k) {
      if (k === 'run') return (a: string[], o = {}) => t.run(a, { ...o, credentials: creds, repoName: undefined });
      if (k === 'info') return (p: string, o = {}) => t.info(p, { ...o, credentials: creds, repoName: undefined });
      if (k === 'status') return (p: string, o = {}) => t.status(p, { ...o, credentials: creds, repoName: undefined });
      return Reflect.get(t, k) as unknown;
    },
  }) as SvnClient;

  const project = `sc-${Date.now()}`;
  const proj = `${ROOT}/${project}`;
  const wc = path.join(BASE, 'wc');
  const trunk = path.join(wc, 'trunk');
  const big = path.join(trunk, 'big.txt');
  const many = path.join(trunk, 'many.txt');
  const entry = (f: string): RepoEntry => ({ name: REPO, serverUrl: proj, localFolder: f });
  const mc = (f: string) => ({ client, repo: entry(f), cwd: f });
  const sh = async (args: string[], cwd?: string): Promise<string> => (await client.run(args, { cwd })).text;
  const commit = async (msg: string, ...p: string[]): Promise<number> => Number(/Committed revision (\d+)/.exec(await sh(['commit', '-m', msg, '--', ...p], wc))?.[1]);
  const target = (f: string): HistoryTarget => ({ repoName: REPO, fsPath: f, cwd: wc });
  const rev: Record<string, number> = {};
  const manyRevs: number[] = [];
  const allRevs: number[] = [];
  const lineCount = (f: string): number => fs.readFileSync(f, 'utf8').split('\n').length - 1;

  beforeAll(() => {
    fs.mkdirSync(path.join(BASE, 'appdata'), { recursive: true });
    process.env.APPDATA = path.join(BASE, 'appdata');
  });
  afterAll(async () => {
    await client.run(['delete', '-m', 'cleanup scale test', '--', proj], {}).catch(() => undefined);
    rmTree(BASE);
  });

  it('creates a project with a branch made before 300+ trunk revisions', async () => {
    await sh(['mkdir', '--parents', '-m', 'scale layout', '--', `${proj}/trunk`, `${proj}/branches`, `${proj}/tags`]);
    await sh(['checkout', '-q', '--', proj, wc]);
    fs.writeFileSync(many, Array.from({ length: SLOTS }, (_, k) => `slot ${k}\n`).join(''));
    await sh(['add', '--', many], wc);
    rev.m0 = await commit('m0 many.txt with empty slots', many);
    await createRef({ client, repo: entry(wc), tmpDir: path.join(BASE, 'tmp') }, { kind: 'url', url: `${proj}/trunk`, rev: rev.m0 }, `${proj}/branches/early`, 'branch before many revisions');
    await sh(['update', '-q'], wc);
  });

  it(`commits ${MANY} small revisions`, async () => {
    const lines = fs.readFileSync(many, 'utf8').split('\n');
    for (let i = 1; i <= MANY; i++) {
      lines[slotOf(i)] = `line ${i}`;
      fs.writeFileSync(many, lines.join('\n'));
      manyRevs.push(await commit(`rev-${String(i).padStart(4, '0')}`, many));
    }
    expect(new Set(manyRevs).size).toBe(MANY);
    expect(manyRevs[MANY - 1] - manyRevs[0]).toBeGreaterThanOrEqual(MANY - 1);
  }, 600_000);

  it('blames a file with 300+ revisions, one revision per line, also with -x -w', async () => {
    const cache = new BlameCache();
    const d = await loadBlame(client, cache, { repoName: REPO, fsPath: many, cwd: wc });
    const expected = Array.from({ length: SLOTS }, (_, k) => (k % 3 === 1 ? manyRevs[(k - 1) / 3] : rev.m0));
    expect(d.lines.map((l) => l.revision)).toEqual(expected);
    const w = await loadBlame(client, cache, { repoName: REPO, fsPath: many, cwd: wc }, { ignoreWhitespace: true });
    expect(w.lines.map((l) => l.revision)).toEqual(expected);
    const m = mapBlameToText(d.lines, d.baseText, d.baseText.replace('line 150\n', 'LOCAL\n'));
    expect(m[slotOf(150)]).toBeUndefined();
    expect(m[slotOf(151)]?.revision).toBe(manyRevs[150]);
    expect(m[slotOf(150) - 1]?.revision).toBe(rev.m0);
  }, 120_000);

  it('pages through 300+ revisions in order, without duplicates', async () => {
    const t = target(trunk);
    const all: number[] = [];
    let cursor: number | undefined;
    let pages = 0;
    do {
      const p = await loadPage(logBatchFetcher(client, t, {}), {}, 50, cursor);
      all.push(...p.entries.map((e) => e.revision));
      cursor = p.nextCursor;
      pages++;
    } while (cursor !== undefined && pages < 20);
    allRevs.push(...all);
    expect(all.slice(0, MANY)).toEqual([...manyRevs].reverse());
    expect(all).toEqual([...all].sort((a, b) => b - a));
    expect(new Set(all).size).toBe(all.length);
    expect(all).toContain(rev.m0);
    expect(pages).toBeGreaterThanOrEqual(Math.ceil(MANY / 50));
  }, 120_000);

  it('applies client-side filters across several scan batches', async () => {
    const t = target(trunk);
    const f = (x: LogFilter, size = 50) => loadPage(logBatchFetcher(client, t, x), x, size);
    // the oldest matches lie beyond the first 200-entry scan batch
    expect((await f({ text: 'rev-0005' })).entries.map((e) => e.revision)).toEqual([manyRevs[4]]);
    expect((await f({ text: 'rev-0300' })).entries.map((e) => e.revision)).toEqual([manyRevs[299]]);
    const first = await f({ author: 'tester' }, 120);
    expect(first.entries).toHaveLength(120);
    expect(first.nextCursor).toBeDefined();
    const second = await loadPage(logBatchFetcher(client, t, { author: 'tester' }), { author: 'tester' }, 120, first.nextCursor);
    expect(second.entries[0].revision).toBe(allRevs[allRevs.indexOf(first.entries[119].revision) + 1]);
    expect((await f({ author: 'nobody' })).entries).toHaveLength(0);
    const range = await f({ revFrom: manyRevs[99], revTo: manyRevs[199] }, 500);
    expect(range.entries.map((e) => e.revision)).toEqual(manyRevs.slice(99, 200).reverse());
    expect((await f({ path: 'many.txt' }, 500)).entries).toHaveLength(MANY + 1);
    expect((await f({ text: 'no-such-message-anywhere' })).entries).toHaveLength(0);
    const today = new Date().toISOString().slice(0, 10);
    expect((await f({ dateFrom: today, dateTo: today }, 400)).entries.length).toBeGreaterThanOrEqual(MANY);
  }, 120_000);

  it('diffs, updates and reverts at old revisions of a file with 300+ revisions', async () => {
    const info = await targetInfo(client, target(many));
    const repoPath = info.url.slice(info.root.length);
    const mid = manyRevs[99];
    const before = await catAtRevision(client, REPO, info.root, repoPath, mid - 1, wc);
    const after = await catAtRevision(client, REPO, info.root, repoPath, mid, wc);
    expect(diffLines(before, after).hunks).toHaveLength(1);
    expect(after).toContain('line 100\n');
    expect(after).not.toContain('line 101\n');

    const rv = await revertChangesOfRevision(client, target(many), mid);
    expect(rv.conflicts).toEqual([]);
    expect(fs.readFileSync(many, 'utf8')).not.toContain('line 100\n');
    expect(fs.readFileSync(many, 'utf8')).toContain('line 99\n');
    await sh(['revert', '--', many], wc);

    const to = await revertToRevision(client, target(many), manyRevs[9]);
    expect(to.conflicts).toEqual([]);
    expect(fs.readFileSync(many, 'utf8')).toContain('line 10\n');
    expect(fs.readFileSync(many, 'utf8')).not.toContain('line 11\n');
    await sh(['revert', '--', many], wc);

    await updateToRevision(client, target(trunk), manyRevs[49]);
    expect(fs.readFileSync(many, 'utf8')).toContain('line 50\n');
    expect(fs.readFileSync(many, 'utf8')).not.toContain('line 51\n');
    await updateToRevision(client, target(trunk), manyRevs[MANY - 1]);
    expect(fs.readFileSync(many, 'utf8')).toContain(`line ${MANY}\n`);
  }, 120_000);

  it('lists and merges 300+ eligible revisions into the early branch', async () => {
    const early = path.join(BASE, 'early');
    await sh(['checkout', '-q', '--', `${proj}/branches/early`, early]);
    const c = mc(early);
    const eligible = await mergeinfoRevs(c, 'eligible', `${proj}/trunk`, '.');
    expect(eligible).toEqual(manyRevs);
    const log = await logOfRevs(c, `${proj}/trunk`, eligible);
    expect(log).toHaveLength(MANY);
    expect(log[0].message).toBe(`rev-${String(MANY).padStart(4, "0")}`);

    const part = await runMerge(c, { kind: 'range', source: `${proj}/trunk`, target: '.', revs: `${manyRevs[0]}-${manyRevs[99]}` });
    expect(part.conflicts).toEqual([]);
    expect(fs.readFileSync(path.join(early, 'many.txt'), 'utf8')).toContain('line 100\n');
    expect(fs.readFileSync(path.join(early, 'many.txt'), 'utf8')).not.toContain('line 101\n');
    expect((await mergeinfoRevs(c, 'eligible', `${proj}/trunk`, '.')).length).toBe(MANY - 100);
    await sh(['revert', '-R', '.'], early);

    const sync = await runMerge(c, { kind: 'sync', source: `${proj}/trunk`, target: '.' });
    expect(sync.conflicts).toEqual([]);
    expect(fs.readFileSync(path.join(early, 'many.txt'), 'utf8')).toBe(fs.readFileSync(many, 'utf8'));
    expect(await localChangeCount(c, '.')).toBeGreaterThan(0);
  }, 300_000);

  it(`handles a ${BIG_LINES}-line file: commits, blame, per-revision diff`, async () => {
    const v1 = bigText('orig');
    expect(v1.length).toBeGreaterThan(3_000_000);
    fs.writeFileSync(big, v1);
    await sh(['add', '--', big], wc);
    rev.b1 = await commit('b1 big file', big);
    const v2 = v1.split('\n').map((l, i) => (i % 1000 === 0 && l ? l.replace('orig', 'EDIT') : l)).join('\n');
    fs.writeFileSync(big, v2);
    rev.b2 = await commit('b2 scattered edits', big);
    const ls = v2.split('\n');
    ls.splice(30_000, 0, ...Array.from({ length: 500 }, (_, i) => `inserted ${i}`));
    const v3 = ls.join('\n');
    fs.writeFileSync(big, v3);
    rev.b3 = await commit('b3 insert block', big);

    const t0 = Date.now();
    const d = await loadBlame(client, new BlameCache(), { repoName: REPO, fsPath: big, cwd: wc });
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(d.lines).toHaveLength(BIG_LINES + 500);
    expect(d.baseText).toBe(v3);
    expect(d.lines[0].revision).toBe(rev.b2);
    expect(d.lines[1].revision).toBe(rev.b1);
    expect(d.lines[30_000].revision).toBe(rev.b3);
    expect(d.lines[30_499].revision).toBe(rev.b3);
    expect(d.lines[30_500].revision).toBe(rev.b2);

    const t1 = Date.now();
    const m = mapBlameToText(d.lines, d.baseText, v3.replace('orig 000007', 'LOCAL 000007'));
    expect(Date.now() - t1).toBeLessThan(10_000);
    expect(m[7]).toBeUndefined();
    expect(m[8]?.revision).toBe(rev.b1);

    const info = await targetInfo(client, target(big));
    const rp = info.url.slice(info.root.length);
    const a = await catAtRevision(client, REPO, info.root, rp, rev.b2, wc);
    const b = await catAtRevision(client, REPO, info.root, rp, rev.b3, wc);
    expect(a).toBe(v2);
    const t2 = Date.now();
    const diff = diffLines(a, b);
    expect(Date.now() - t2).toBeLessThan(10_000);
    expect(diff.hunks).toHaveLength(1);
  }, 300_000);

  it('reverts and updates a large file to older revisions', async () => {
    const rv = await revertChangesOfRevision(client, target(big), rev.b3);
    expect(rv.conflicts).toEqual([]);
    expect(lineCount(big)).toBe(BIG_LINES);
    await sh(['revert', '--', big], wc);
    const to = await revertToRevision(client, target(big), rev.b1);
    expect(to.conflicts).toEqual([]);
    expect(fs.readFileSync(big, 'utf8')).toBe(bigText('orig'));
    await sh(['revert', '--', big], wc);
    await updateToRevision(client, target(big), rev.b1);
    expect(fs.readFileSync(big, 'utf8')).toBe(bigText('orig'));
    await updateToRevision(client, target(big), rev.b3);
    expect(lineCount(big)).toBe(BIG_LINES + 500);
  }, 300_000);

  it('tags and exports the large file and an old folder revision byte-exactly', async () => {
    const c = { client, repo: entry(wc), tmpDir: path.join(BASE, 'tmp') };
    await createRef(c, { kind: 'url', url: `${proj}/trunk`, rev: rev.b1 }, `${proj}/tags/big-v1`, 'tag at b1');
    expect(await sh(['cat', '--', `${proj}/tags/big-v1/big.txt`])).toBe(bigText('orig'));
    await createRef(c, { kind: 'wc', path: trunk }, `${proj}/tags/from-wc`, 'tag from working copy');
    expect(lineCount(big)).toBe(BIG_LINES + 500);
    expect((await sh(['cat', '--', `${proj}/tags/from-wc/big.txt`])).split('\n')).toHaveLength(BIG_LINES + 501);

    const out = path.join(BASE, 'export');
    fs.mkdirSync(out, { recursive: true });
    const ctx = { client, repo: entry(wc) };
    await runExport(ctx, { source: `${proj}/trunk/big.txt@${rev.b1}`, dest: path.join(out, 'big-b1.txt'), rev: rev.b1, depth: 'infinity', eol: 'default', ignoreExternals: false, force: false });
    expect(fs.readFileSync(path.join(out, 'big-b1.txt'), 'utf8')).toBe(bigText('orig'));
    await runExport(ctx, { source: `${proj}/trunk@${manyRevs[149]}`, dest: path.join(out, 'folder'), rev: manyRevs[149], depth: 'infinity', eol: 'default', ignoreExternals: true, force: false });
    const old = fs.readFileSync(path.join(out, 'folder', 'many.txt'), 'utf8');
    expect(old).toContain('line 150\n');
    expect(old).not.toContain('line 151\n');
    expect(fs.existsSync(path.join(out, 'folder', 'big.txt'))).toBe(false);
    await runExport(ctx, { source: trunk, dest: path.join(out, 'wc'), depth: 'infinity', eol: 'default', ignoreExternals: false, force: false });
    expect(fs.statSync(path.join(out, 'wc', 'big.txt')).size).toBe(fs.statSync(big).size);
  }, 300_000);
});

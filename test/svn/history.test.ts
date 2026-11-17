/**
 * Live tests of blame (task 19-20) and history (21-22) against the local servers. Own scratch
 * checkouts under F:\TrashCache\svn-history-vitest; every run works in a fresh folder of trunk so
 * concurrent commits by other suites do not matter. Skipped when servers or svn.exe are missing.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll,beforeAll, describe, expect, it } from 'vitest';
import { rmTree, runDir } from './scratch';
import { BlameCache, mapBlameToText } from '../../src/blame/model';
import { MessageCache, loadBlame } from '../../src/blame/service';
import { LogFilter, loadPage } from '../../src/history/model';
import { HistoryTarget, logBatchFetcher, revertChangesOfRevision, revertToRevision, targetInfo, updateToRevision, catAtRevision } from '../../src/history/service';
import { Credentials, SvnClient } from '../../src/svn/client';
import { findSvnExe } from '../../src/svn/discovery';
import { SvnLocator } from '../../src/svn/locator';

const BASE = runDir('svn-history-vitest');
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
if (!enabled) console.warn('[test:svn] history tests SKIPPED: servers or svn.exe unavailable');

const silent = { info() {}, warn() {}, error() {}, debug() {} };

describe.skipIf(!enabled)('blame and history against local servers', () => {
  const raw = new SvnClient(new SvnLocator(() => '', () => ({ path: exe, tried: [] })), undefined, silent, () => 60_000);

  afterAll(() => rmTree(BASE));
  beforeAll(() => {
    const appdata = path.join(BASE, 'appdata');
    fs.mkdirSync(appdata, { recursive: true });
    process.env.APPDATA = appdata;
    fs.mkdirSync(BASE, { recursive: true });
  });

  describe.each(CASES)('$repo over $proto', ({ proto, repo, url, trust }) => {
    const wc = path.join(BASE, `${repo}-${proto}`);
    const creds: Credentials = { ...TESTER, trustServerCert: trust };
    const client = new Proxy(raw, {
      get(t, k) {
        if (k === 'run') return (a: string[], o = {}) => t.run(a, { ...o, credentials: creds, repoName: undefined });
        if (k === 'info') return (p: string, o = {}) => t.info(p, { ...o, credentials: creds, repoName: undefined });
        return Reflect.get(t, k) as unknown;
      },
    }) as SvnClient;
    const dirName = `hist-${Date.now()}`;
    const dir = path.join(wc, dirName);
    const file = path.join(dir, 'f.txt');
    const target: HistoryTarget = { repoName: repo, fsPath: dir, cwd: wc };
    const fileTarget: HistoryTarget = { repoName: repo, fsPath: file, cwd: wc };
    const revs: number[] = [];

    const commit = async (msg: string, ...paths: string[]): Promise<number> => {
      const r = await client.run(['commit', '-m', msg, '--', ...paths], { cwd: wc });
      const m = /Committed revision (\d+)/.exec(r.text);
      return Number(m?.[1]);
    };

    it('prepares a folder with several revisions', async () => {
      await client.run(['checkout', '--', url, wc], {});
      fs.mkdirSync(dir);
      fs.writeFileSync(file, 'one\ntwo\nthree\n');
      fs.writeFileSync(path.join(dir, 'g.txt'), 'g1\n');
      await client.run(['add', '--', dir], { cwd: wc });
      revs.push(await commit('r-a: create files\n\nsecond paragraph', dir));
      fs.writeFileSync(file, 'one\nTWO changed\nthree\nfour\n');
      revs.push(await commit('r-b: change f', file));
      fs.writeFileSync(path.join(dir, 'g.txt'), 'g1\ng2\n');
      revs.push(await commit('r-c: change g only', path.join(dir, 'g.txt')));
      fs.writeFileSync(file, 'zero\none\nTWO changed\nthree\nfour\n');
      revs.push(await commit('r-d: prepend to f', file));
      expect(revs.every((r) => r > 0)).toBe(true);
      await client.run(['update', '--', wc], {});
    });

    it('blames per line and caches by file + revision', async () => {
      const cache = new BlameCache();
      const t = { repoName: repo, fsPath: file, cwd: wc };
      const d = await loadBlame(client, cache, t);
      expect(d.lines.map((l) => l.revision)).toEqual([revs[3], revs[0], revs[1], revs[0], revs[1]]);
      expect(d.lines[0].author).toBe('tester');
      expect(d.baseText).toBe('zero\none\nTWO changed\nthree\nfour\n');
      expect(await loadBlame(client, cache, t)).toBe(d);
      expect(cache.size).toBe(1);
      const w = await loadBlame(client, cache, t, { ignoreWhitespace: true });
      expect(w.lines).toHaveLength(5);
      expect(cache.size).toBe(2);
      cache.invalidate(file);
      expect(cache.get(file, d.revision)).toBeUndefined();
    });

    it('keeps blame aligned for a dirty file and marks local edits uncommitted', async () => {
      const cache = new BlameCache();
      const d = await loadBlame(client, cache, { repoName: repo, fsPath: file, cwd: wc });
      const dirty = 'LOCAL TOP\nzero\none\nTWO edited locally\nthree\nfour\nLOCAL END\n';
      const m = mapBlameToText(d.lines, d.baseText, dirty);
      expect(m.map((x) => x?.revision)).toEqual([undefined, revs[3], revs[0], undefined, revs[0], revs[1], undefined]);
      const msgs = new MessageCache(client);
      expect(await msgs.get(repo, file, revs[0], wc)).toContain('second paragraph');
      expect(await msgs.get(repo, file, revs[1], wc)).toBe('r-b: change f');
    });

    it('lists history of a folder with all filters', async () => {
      const f = (x: LogFilter) => loadPage(logBatchFetcher(client, target, x), x, 50);
      const all = await f({});
      expect(all.entries.map((e) => e.revision)).toEqual([...revs].reverse());
      expect(all.entries[3].paths.some((p) => p.path.endsWith(`/${dirName}/f.txt`))).toBe(true);
      expect(all.nextCursor).toBeUndefined();
      // stays correct when the user's page is smaller than the history
      const p1 = await loadPage(logBatchFetcher(client, target, {}), {}, 2);
      expect(p1.entries.map((e) => e.revision)).toEqual([revs[3], revs[2]]);
      const p2 = await loadPage(logBatchFetcher(client, target, {}), {}, 2, p1.nextCursor);
      expect(p2.entries.map((e) => e.revision)).toEqual([revs[1], revs[0]]);
      expect(p2.nextCursor === undefined || (await loadPage(logBatchFetcher(client, target, {}), {}, 2, p2.nextCursor)).entries.length === 0).toBe(true);
      expect((await f({ text: 'change g' })).entries.map((e) => e.revision)).toEqual([revs[2]]);
      expect((await f({ path: 'g.txt' })).entries.map((e) => e.revision)).toEqual([revs[2], revs[0]]);
      expect((await f({ author: 'TESTER' })).entries).toHaveLength(4);
      expect((await f({ author: 'nobody' })).entries).toHaveLength(0);
      expect((await f({ revFrom: revs[1], revTo: revs[2] })).entries.map((e) => e.revision)).toEqual([revs[2], revs[1]]);
      const today = new Date().toISOString().slice(0, 10);
      expect((await f({ dateFrom: today, dateTo: today })).entries.length).toBeGreaterThanOrEqual(4);
      expect((await f({ dateFrom: '2000-01-01', dateTo: '2000-01-02' })).entries).toHaveLength(0);
      const fileLog = await loadPage(logBatchFetcher(client, fileTarget, {}), {}, 50);
      expect(fileLog.entries.map((e) => e.revision)).toEqual([revs[3], revs[1], revs[0]]);
    });

    it('fetches content at rev-1 and rev for the per-revision diff', async () => {
      const info = await targetInfo(client, target);
      expect(info.root.startsWith(url.split('/trunk')[0])).toBe(true);
      const repoPath = `${info.url.slice(info.root.length)}/f.txt`;
      expect(await catAtRevision(client, repo, info.root, repoPath, revs[1], wc)).toBe('one\nTWO changed\nthree\nfour\n');
      expect(await catAtRevision(client, repo, info.root, repoPath, revs[1] - 1, wc).catch(() => 'MISSING')).toBe(revs[1] - 1 >= revs[0] ? 'one\ntwo\nthree\n' : 'MISSING');
    });

    it('reverts the changes of one revision (reverse merge) without committing', async () => {
      const r = await revertChangesOfRevision(client, fileTarget, revs[3]);
      expect(r.conflicts).toEqual([]);
      expect(fs.readFileSync(file, 'utf8')).toBe('one\nTWO changed\nthree\nfour\n');
      await client.run(['revert', '--', file], { cwd: wc });
    });

    it('reverts to a revision (merge -r HEAD:REV)', async () => {
      const r = await revertToRevision(client, fileTarget, revs[0]);
      expect(r.conflicts).toEqual([]);
      expect(fs.readFileSync(file, 'utf8')).toBe('one\ntwo\nthree\n');
      await client.run(['revert', '--', file], { cwd: wc });
      expect(fs.readFileSync(file, 'utf8')).toBe('zero\none\nTWO changed\nthree\nfour\n');
    });

    it('reports conflicts when reverting over conflicting local edits', async () => {
      fs.writeFileSync(file, 'zero\none\nLOCAL CONFLICT\nthree\nfour\n');
      const r = await revertChangesOfRevision(client, fileTarget, revs[1]);
      expect(r.conflicts.length).toBeGreaterThan(0);
      await client.run(['revert', '-R', '--', dir], { cwd: wc });
      for (const f of fs.readdirSync(dir)) if (/\.(r\d+|mine|merge-\S*)$|\.working$|\.rej$/.test(f)) fs.rmSync(path.join(dir, f));
    });

    it('updates a folder to an older revision', async () => {
      const r = await updateToRevision(client, target, revs[0]);
      expect(r.conflicts).toEqual([]);
      expect(fs.readFileSync(file, 'utf8')).toBe('one\ntwo\nthree\n');
      await updateToRevision(client, target, revs[3]);
      expect(fs.readFileSync(file, 'utf8')).toBe('zero\none\nTWO changed\nthree\nfour\n');
    });

    it('follows a copy with --stop-on-copy', async () => {
      const copy = path.join(wc, `${dirName}-copy`);
      await client.run(['copy', '--', dir, copy], { cwd: wc });
      const crev = await commit('r-e: copy folder', copy);
      const ct: HistoryTarget = { repoName: repo, fsPath: copy, cwd: wc };
      const stop = await loadPage(logBatchFetcher(client, ct, { stopOnCopy: true }), { stopOnCopy: true }, 50);
      expect(stop.entries.map((e) => e.revision)).toEqual([crev]);
      expect(stop.entries[0].paths[0].copyfromRev).toBe(revs[3]);
      const full = await loadPage(logBatchFetcher(client, ct, {}), {}, 50);
      expect(full.entries.map((e) => e.revision)).toEqual([crev, ...[...revs].reverse()]);
    });
  });
});

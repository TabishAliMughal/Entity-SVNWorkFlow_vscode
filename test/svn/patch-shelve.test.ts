/**
 * Live tests of diff modes, patch create/apply and shelving (tasks 41-43) against the local servers. Each run works
 * in its own project folder, with checkouts under F:\TrashCache\svn-patch-vitest. Skipped when servers or svn.exe are missing.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmTree, runDir } from './scratch';
import { pairFor, parseDiffSummary, summarizeArgs, type FolderMode } from '../../src/diffmodes/model';
import { diffLines } from '../../src/diff';
import { fetchContent } from '../../src/compare/fetch';
import { buildPatch, collectChanges } from '../../src/patch/create';
import { runPatch } from '../../src/patch/ops';
import { parseUnifiedDiff } from '../../src/patch/parse';
import { unifiedFileDiff } from '../../src/patch/unified';
import type { RepoEntry } from '../../src/repos/model';
import { Credentials, SvnClient } from '../../src/svn/client';
import { findSvnExe } from '../../src/svn/discovery';
import { SvnLocator } from '../../src/svn/locator';
import { deleteShelf, dirtyTargets, listShelves, previewShelf, probeNative, resetNativeProbe, shelve, unshelve, type ShelfCtx } from '../../src/shelve/ops';
import { ShelfStore } from '../../src/shelve/store';

const BASE = runDir('svn-patch-vitest');
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
if (!enabled) console.warn('[test:svn] patch/shelve tests SKIPPED: servers or svn.exe unavailable');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const rmdir = (d: string): void => void spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', d], { stdio: 'ignore' });
const BIN = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 255]);

describe.skipIf(!enabled)('diff modes, patches and shelving against local servers', () => {
  const raw = new SvnClient(new SvnLocator(() => '', () => ({ path: exe, tried: [] })), undefined, silent, () => 60_000);

  beforeAll(() => {
    const appdata = path.join(BASE, 'appdata');
    fs.mkdirSync(appdata, { recursive: true });
    process.env.APPDATA = appdata;
    fs.mkdirSync(BASE, { recursive: true });
  });
  afterAll(() => rmTree(BASE));

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
    const project = `pt-${Date.now()}`;
    const proj = `${root}/${project}`;
    const wc = path.join(BASE, `${repo}-${proto}`, 'trunk');
    const entry: RepoEntry = { name: repo, serverUrl: `${proj}/trunk`, localFolder: wc };
    const store = new ShelfStore(path.join(BASE, `${repo}-${proto}`, 'store'));
    const tmpDir = path.join(BASE, 'tmp');
    const sh = async (args: string[], cwd: string = wc): Promise<string> => (await client.run(args, { cwd })).text;
    const commit = async (msg: string): Promise<number> => Number(/Committed revision (\d+)/.exec(await sh(['commit', '-m', msg]))?.[1]);
    const w = (f: string, data: string | Buffer): void => {
      fs.mkdirSync(path.dirname(path.join(wc, f)), { recursive: true });
      fs.writeFileSync(path.join(wc, f), data);
    };
    const r = (f: string): string => fs.readFileSync(path.join(wc, f), 'utf8');
    const ctx = (mode: ShelfCtx['mode']): ShelfCtx => ({ client, repo: entry, store, tmpDir, mode, context: 3 });
    const status = async (): Promise<string> => (await sh(['status'])).split(/\r?\n/).filter(Boolean).sort().join('|');
    let rev1 = 0;

    afterAll(async () => {
      await client.run(['delete', '-m', 'cleanup patch test', '--', proj], {}).catch(() => undefined);
    });

    const A1 = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n';

    it('prepares trunk with text, CRLF, no-final-newline and binary files', async () => {
      await client.run(['mkdir', '--parents', '-m', 'layout', '--', `${proj}/trunk`, `${proj}/branches`], {});
      await client.run(['checkout', '-q', '--', `${proj}/trunk`, wc], {});
      w('a.txt', A1);
      w('crlf.txt', 'x\r\ny\r\nz\r\n');
      w('noeol.txt', 'last line without newline');
      w('b.txt', 'to be deleted\n');
      w('d/c.txt', 'c1\nc2\n');
      w('bin.dat', BIN);
      await sh(['add', '--force', '.']);
      await sh(['propset', 'svn:mime-type', 'application/octet-stream', 'bin.dat']);
      rev1 = await commit('initial');
      expect(rev1).toBeGreaterThan(0);
    });

    describe('diff modes', () => {
      it('lists working vs BASE, HEAD and revision changes and pairs per-file sources', async () => {
        try {
        w('a.txt', A1.replace('three', 'THREE'));
        w('new.txt', 'brand new\n');
        await sh(['add', 'new.txt']);
        const base: FolderMode = { mode: 'base' };
        const res = await client.run(summarizeArgs(base), { cwd: wc, xml: true });
        const entries = parseDiffSummary(res.text, base);
        expect(entries.map((e) => `${e.item}:${e.rel}`).sort()).toEqual(['added:new.txt', 'modified:a.txt']);
        const a = entries.find((e) => e.rel === 'a.txt');
        if (!a) throw new Error('a.txt missing from the summary');
        const pair = pairFor(base, repo, wc, a);
        expect(pair.left).toMatchObject({ kind: 'local' });
        expect(pair.right).toMatchObject({ kind: 'rev', rev: 'BASE' });
        expect(pair.editableSide).toBe('left');
        const left = await fetchContent(client, { repoName: repo, target: (pair.right as { target: string }).target, rev: 'BASE' });
        expect(diffLines(left.text, r('a.txt')).hunks).toHaveLength(1);

        const head: FolderMode = { mode: 'head' };
        const hr = parseDiffSummary((await client.run(summarizeArgs(head), { cwd: wc, xml: true })).text, head);
        expect(hr.filter((e) => e.kind === 'file').map((e) => e.rel).sort()).toEqual(['a.txt', 'new.txt']);
        const rv: FolderMode = { mode: 'rev', rev: rev1 };
        const rr = parseDiffSummary((await client.run(summarizeArgs(rv), { cwd: wc, xml: true })).text, rv);
        expect(rr.filter((e) => e.kind === 'file').map((e) => e.rel).sort()).toEqual(['a.txt', 'new.txt']);
        } finally {
          await sh(['revert', '-R', '.']).catch(() => undefined);
          fs.rmSync(path.join(wc, 'new.txt'), { force: true });
        }
        expect(await status()).toBe('');
      });

      it('diffs the same path between two branches (URL@rev vs URL@rev)', async () => {
        await client.run(['copy', '-m', 'branch b1', '--', `${proj}/trunk`, `${proj}/branches/b1`], {});
        const bwc = path.join(BASE, `${repo}-${proto}`, 'b1');
        await client.run(['checkout', '-q', '--', `${proj}/branches/b1`, bwc], {});
        fs.writeFileSync(path.join(bwc, 'a.txt'), A1.replace('five', 'FIVE').replace('ten\n', 'ten\neleven\n'));
        fs.writeFileSync(path.join(bwc, 'only-b1.txt'), 'b1\n');
        fs.rmSync(path.join(bwc, 'b.txt'));
        await sh(['add', 'only-b1.txt'], bwc);
        await sh(['delete', 'b.txt'], bwc).catch(() => undefined);
        await sh(['commit', '-m', 'b1 edits'], bwc);

        const m: FolderMode = { mode: 'urls', oldUrl: `${proj}/trunk`, oldRev: 'HEAD', newUrl: `${proj}/branches/b1`, newRev: 'HEAD' };
        const entries = parseDiffSummary((await client.run(summarizeArgs(m), { xml: true })).text, m);
        expect(entries.filter((e) => e.kind === 'file').map((e) => `${e.item}:${e.rel}`).sort()).toEqual(['added:only-b1.txt', 'deleted:b.txt', 'modified:a.txt']);

        const a = entries.find((e) => e.rel === 'a.txt');
        if (!a) throw new Error('a.txt missing');
        const pair = pairFor(m, repo, '', a);
        const l = await fetchContent(client, { repoName: repo, target: (pair.left as { target: string }).target, rev: 'HEAD' });
        const rgt = await fetchContent(client, { repoName: repo, target: (pair.right as { target: string }).target, rev: 'HEAD' });
        expect(l.text).toBe(A1);
        const d = diffLines(l.text, rgt.text);
        expect(d.hunks.map((h) => h.type)).toEqual(['modify', 'insert']);
        // deleted file pairs with an empty right side
        const del = entries.find((e) => e.item === 'deleted');
        expect(pairFor(m, repo, '', del as never).right).toMatchObject({ kind: 'text', text: '' });
        rmdir(bwc);
      });
    });

    describe('patch create / apply', () => {
      let patchFile = '';
      const patchDir = path.join(BASE, `${repo}-${proto}`, 'patches');
      let edited: Record<string, string> = {};
      let editedBin = Buffer.alloc(0);

      it('creates one patch with the engine for text and svn --git for property changes', async () => {
        w('a.txt', A1.replace('three', 'THREE').replace('nine', 'NINE'));
        w('crlf.txt', 'x\r\nY\r\nz\r\n');
        w('noeol.txt', 'last line without newline\nadded after\n');
        w('new.txt', 'brand new\nfile\n');
        await sh(['add', 'new.txt']);
        await sh(['delete', 'b.txt']);
        await sh(['propset', 'svn:eol-style', 'native', 'd/c.txt']);
        w('bin.dat', Buffer.concat([BIN, Buffer.from([7, 7])]));
        const entries = await collectChanges(client, entry, [wc]);
        const built = await buildPatch(client, entry, entries, { context: 3, binary: 'omit' });
        expect(built.engine.sort()).toEqual(['a.txt', 'b.txt', 'crlf.txt', 'new.txt', 'noeol.txt']);
        expect(built.viaSvn.map((v) => v.path)).toEqual(['d/c.txt']);
        expect(built.binary).toEqual(['bin.dat']);
        const text = built.bytes.toString('utf8');
        expect(text).toContain('Index: a.txt');
        expect(text).toContain('--- new.txt\t(nonexistent)');
        expect(text).toContain('\\ No newline at end of file');
        expect(parseUnifiedDiff(text).map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt', 'crlf.txt', 'd/c.txt', 'new.txt', 'noeol.txt']);
        expect(text).toContain('Property changes on: d/c.txt');
        expect(text).not.toContain(project);

        const withBin = await buildPatch(client, entry, entries, { context: 3, binary: 'svn' });
        expect(withBin.viaSvn.map((v) => v.path).sort()).toEqual(['bin.dat', 'd/c.txt']);

        fs.mkdirSync(patchDir, { recursive: true });
        patchFile = path.join(patchDir, 'all.patch');
        fs.writeFileSync(patchFile, withBin.bytes);
        expect(withBin.bytes.toString('latin1')).toContain('GIT binary patch');
        expect(withBin.bytes.toString('latin1')).not.toContain(project);
        editedBin = fs.readFileSync(path.join(wc, 'bin.dat'));
        edited = { 'a.txt': r('a.txt'), 'crlf.txt': r('crlf.txt'), 'noeol.txt': r('noeol.txt'), 'new.txt': r('new.txt') };
      });

      it('svn diff agrees with our patch: applying ours to a clean checkout equals the working copy', async () => {
        await sh(['revert', '-R', '.']);
        fs.rmSync(path.join(wc, 'new.txt'), { force: true });
        expect(await status()).toBe('');
        const dry = await runPatch({ client, repo: entry, cwd: wc }, { patchFile, dryRun: true });
        expect(dry.outcome.entries.map((e) => e.path.replace(/\\/g, '/')).sort()).toEqual(['a.txt', 'b.txt', 'bin.dat', 'crlf.txt', 'd/c.txt', 'new.txt', 'noeol.txt']);
        expect(dry.outcome.conflicts).toEqual([]);
        expect(r('a.txt')).toBe(A1);
        expect(fs.existsSync(path.join(wc, 'new.txt'))).toBe(false);

        const real = await runPatch({ client, repo: entry, cwd: wc }, { patchFile });
        expect(real.rejects).toEqual([]);
        for (const [f, text] of Object.entries(edited)) expect(r(f)).toBe(text);
        expect(fs.readFileSync(path.join(wc, 'bin.dat')).equals(editedBin)).toBe(true);
        expect(await sh(['propget', 'svn:eol-style', 'd/c.txt'])).toContain('native');
        expect(fs.existsSync(path.join(wc, 'b.txt'))).toBe(false);
        expect(await status()).toContain('A       new.txt');
        expect(await status()).toContain('D       b.txt');
        expect(r('crlf.txt')).toBe('x\r\nY\r\nz\r\n');
      });

      it('reverses a patch', async () => {
        const rev = await runPatch({ client, repo: entry, cwd: wc }, { patchFile, reverse: true });
        expect(rev.rejects).toEqual([]);
        expect(r('a.txt')).toBe(A1);
        expect(r('crlf.txt')).toBe('x\r\ny\r\nz\r\n');
        expect(r('noeol.txt')).toBe('last line without newline');
        expect(fs.existsSync(path.join(wc, 'b.txt'))).toBe(true);
        expect(fs.existsSync(path.join(wc, 'new.txt'))).toBe(false);
        await sh(['revert', '-R', '.']);
        fs.rmSync(path.join(wc, 'new.txt'), { force: true });
        expect(await status()).toBe('');
      });

      it('strips path prefixes', async () => {
        const prefixed = path.join(patchDir, 'prefixed.patch');
        fs.writeFileSync(prefixed, unifiedFileDiff('pre/a.txt', A1, A1.replace('one', 'ONE'), { oldLabel: '(revision 1)' }));
        const miss = await runPatch({ client, repo: entry, cwd: wc }, { patchFile: prefixed, dryRun: true });
        expect(miss.outcome.entries.map((e) => e.path.replace(/\\/g, '/'))).toEqual(['pre/a.txt']);
        expect(r('a.txt')).toBe(A1);
        const ok = await runPatch({ client, repo: entry, cwd: wc }, { patchFile: prefixed, strip: 1 });
        expect(ok.outcome.entries.map((e) => e.path)).toEqual(['a.txt']);
        expect(r('a.txt')).toBe(A1.replace('one', 'ONE'));
        await sh(['revert', '-R', '.']);
      });

      it('reports rejects and writes .svnpatch.rej files', async () => {
        w('a.txt', 'completely\ndifferent\ncontent\n');
        const res = await runPatch({ client, repo: entry, cwd: wc }, { patchFile });
        expect(res.outcome.conflicts).toContain('a.txt');
        expect(res.rejects.map((p) => path.basename(p))).toEqual(['a.txt.svnpatch.rej']);
        expect(fs.readFileSync(res.rejects[0], 'utf8')).toContain('THREE');
        // the other files still applied
        expect(r('crlf.txt')).toBe('x\r\nY\r\nz\r\n');
        await sh(['revert', '-R', '.']);
        for (const f of ['new.txt', 'a.txt.svnpatch.rej']) fs.rmSync(path.join(wc, f), { force: true });
        expect(await status()).toBe('');
      });
    });

    describe('shelving', () => {
      it('uses the patch fallback for modified, added, deleted and binary files, and unshelves it', async () => {
        w('a.txt', A1.replace('two', 'TWO'));
        w('crlf.txt', 'x\r\ny\r\nZ\r\n');
        w('shelf-new.txt', 'shelved new file\n');
        await sh(['add', 'shelf-new.txt']);
        await sh(['delete', 'b.txt']);
        w('bin.dat', Buffer.concat([BIN, Buffer.from([9])]));
        const before = await status();
        expect(before).toContain('M       bin.dat');
        const edited = { a: r('a.txt'), crlf: r('crlf.txt') };
        const bin = fs.readFileSync(path.join(wc, 'bin.dat'));

        const c = ctx('patch');
        const res = await shelve(c, { name: 'fb-one', message: 'first shelf\nwith body', paths: [wc] });
        expect(res.backend).toBe('patch');
        expect(res.files.sort()).toEqual(['a.txt', 'b.txt', 'bin.dat', 'crlf.txt', 'shelf-new.txt']);
        expect(await status()).toBe('');
        expect(fs.existsSync(path.join(wc, 'shelf-new.txt'))).toBe(false);
        expect(fs.existsSync(path.join(wc, 'b.txt'))).toBe(true);
        expect(r('a.txt')).toBe(A1);

        const list = await listShelves(c);
        const info = list.find((s) => s.name === 'fb-one');
        expect(info).toMatchObject({ backend: 'patch', message: 'first shelf\nwith body', fileCount: 5 });
        await expect(shelve(c, { name: 'fb-one', message: '', paths: [wc] })).rejects.toThrow(/already exists/);
        await expect(shelve(c, { name: 'empty-one', message: '', paths: [wc] })).rejects.toThrow(/no shelvable/);

        const pv = await previewShelf(c, info as never);
        const a = pv.find((f) => f.path === 'a.txt');
        expect(a?.baseText).toBe(A1);
        expect(a?.shelvedText).toBe(edited.a);
        expect(pv.find((f) => f.path === 'shelf-new.txt')).toMatchObject({ status: 'added', baseText: '', shelvedText: 'shelved new file\n' });
        expect(pv.find((f) => f.path === 'b.txt')).toMatchObject({ status: 'deleted', shelvedText: '' });
        expect(pv.find((f) => f.path === 'bin.dat')).toMatchObject({ binary: true });

        expect(await dirtyTargets(c, info as never)).toEqual([]);
        const un = await unshelve(c, info as never, { drop: true });
        expect(un.conflicts).toEqual([]);
        expect(un.dropped).toBe(true);
        expect(r('a.txt')).toBe(edited.a);
        expect(r('crlf.txt')).toBe(edited.crlf);
        expect(r('shelf-new.txt')).toBe('shelved new file\n');
        expect(fs.existsSync(path.join(wc, 'b.txt'))).toBe(false);
        expect(fs.readFileSync(path.join(wc, 'bin.dat')).equals(bin)).toBe(true);
        expect(await status()).toBe(before);
        expect((await listShelves(c)).find((s) => s.name === 'fb-one')).toBeUndefined();
        await sh(['revert', '-R', '.']);
        fs.rmSync(path.join(wc, 'shelf-new.txt'), { force: true });
      });

      it('shelves selected files only, flags dirty targets and deletes a shelf', async () => {
        w('a.txt', A1.replace('four', 'FOUR'));
        w('crlf.txt', 'x\r\ny\r\nQ\r\n');
        const c = ctx('patch');
        await shelve(c, { name: 'only-a', message: '', paths: [path.join(wc, 'a.txt')] });
        expect(r('a.txt')).toBe(A1);
        expect(r('crlf.txt')).toBe('x\r\ny\r\nQ\r\n');
        const info = (await listShelves(c)).find((s) => s.name === 'only-a');
        expect(info?.fileCount).toBe(1);
        w('a.txt', A1 + 'local edit\n');
        expect(await dirtyTargets(c, info as never)).toEqual(['a.txt']);
        await deleteShelf(c, info as never);
        expect((await listShelves(c)).find((s) => s.name === 'only-a')).toBeUndefined();
        await sh(['revert', '-R', '.']);
      });

      it('keeps a shelf whose unshelve produces rejects', async () => {
        w('a.txt', A1.replace('six', 'SIX'));
        const c = ctx('patch');
        await shelve(c, { name: 'will-reject', message: '', paths: [wc] });
        w('a.txt', 'nothing\nin\ncommon\n');
        const info = (await listShelves(c)).find((s) => s.name === 'will-reject');
        const un = await unshelve(c, info as never, { drop: true });
        expect(un.conflicts).toEqual(['a.txt']);
        expect(un.rejects).toHaveLength(1);
        expect(un.dropped).toBe(false);
        expect((await listShelves(c)).some((s) => s.name === 'will-reject')).toBe(true);
        await deleteShelf(c, info as never);
        await sh(['revert', '-R', '.']);
        fs.rmSync(path.join(wc, 'a.txt.svnpatch.rej'), { force: true });
        expect(await status()).toBe('');
      });

      it('native svn x-shelve when available (svn 1.14 experimental), with auto falling back to patch otherwise', async () => {
        resetNativeProbe();
        const probe = await probeNative(ctx('auto'));
        if (!probe.env) {
          console.warn(`[test:svn] native shelving unavailable: ${probe.reason}`);
          w('a.txt', A1.replace('two', 'TWO'));
          const r1 = await shelve(ctx('auto'), { name: 'auto-fb', message: '', paths: [wc] });
          expect(r1.backend).toBe('patch');
          await deleteShelf(ctx('auto'), { name: 'auto-fb', backend: 'patch', message: '', fileCount: 1 });
          await sh(['revert', '-R', '.']);
          return;
        }
        console.warn('[test:svn] native shelving exercised: SVN_EXPERIMENTAL_COMMANDS=' + probe.env.SVN_EXPERIMENTAL_COMMANDS);
        expect(probe.env.SVN_EXPERIMENTAL_COMMANDS).toBeTruthy();
        w('a.txt', A1.replace('two', 'TWO'));
        const edited = r('a.txt');
        const c = ctx('native');
        const res = await shelve(c, { name: 'nat-one', message: 'native shelf', paths: [path.join(wc, 'a.txt')] });
        expect(res.backend).toBe('native');
        expect(r('a.txt')).toBe(A1);
        const info = (await listShelves(c)).find((s) => s.name === 'nat-one' && s.backend === 'native');
        expect(info).toMatchObject({ message: 'native shelf', fileCount: 1 });
        const pv = await previewShelf(c, info as never);
        expect(pv[0]).toMatchObject({ path: 'a.txt', baseText: A1, shelvedText: edited });
        const un = await unshelve(c, info as never, { drop: false });
        expect(un.conflicts).toEqual([]);
        expect(r('a.txt')).toBe(edited);
        await deleteShelf(c, info as never).catch((e) => console.warn(`[test:svn] native drop flaky on Windows: ${(e as Error).message}`));
        await sh(['revert', '-R', '.']);
      });

      it('auto mode with a failing native shelve falls back to the patch store', async () => {
        // A shelf name that already exists natively cannot be reused; simulate native failure through a client that rejects x-shelve.
        const failing = new Proxy(client, {
          get(t, k) {
            if (k === 'run') return (a: string[], o = {}) => (a[0] === 'x-shelve' ? Promise.reject(new Error('simulated svn crash')) : (t.run as (a: string[], o: object) => Promise<unknown>)(a, o));
            return Reflect.get(t, k) as unknown;
          },
        }) as SvnClient;
        resetNativeProbe();
        const probe = await probeNative(ctx('auto'));
        w('a.txt', A1.replace('ten', 'TEN'));
        const res = await shelve({ ...ctx('auto'), client: failing }, { name: 'crash-fb', message: '', paths: [wc] });
        expect(res.backend).toBe('patch');
        if (probe.env) expect(res.notes.join(' ')).toMatch(/Native shelving failed/);
        expect(r('a.txt')).toBe(A1);
        await deleteShelf(ctx('patch'), { name: 'crash-fb', backend: 'patch', message: '', fileCount: 1 });
        expect(await status()).toBe('');
      });
    });
  });
});

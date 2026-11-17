/**
 * Live tests of conflict detection, the 3-way merge inputs and every resolve path (src/conflict) against the
 * local servers: real text, property and tree conflicts created with two working copies. Uses its own
 * checkouts (F:\TrashCache\svn-conflict-vitest) and a unique folder in each repo. Skipped when the servers or
 * svn.exe are missing (python test-env/envctl.py reset).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmTree, runDir } from './scratch';
import { buildResult, merge3 } from '../../src/conflict/merge';
import { conflictedItems, conflictKinds, treeAdvice } from '../../src/conflict/model';
import { encodeText } from '../../src/conflict/encode';
import { applyProperty, conflictedProperties, loadConflictInfo, loadTextInputs, readPrej, readPropertyValues, resolvePaths, runTreeSteps, type ConflictCtx } from '../../src/conflict/ops';
import { buildItems } from '../../src/incoming/model';
import { RepoEntry } from '../../src/repos/model';
import { Credentials, SvnClient } from '../../src/svn/client';
import { findSvnExe } from '../../src/svn/discovery';
import { SvnLocator } from '../../src/svn/locator';

const BASE = runDir('svn-conflict-vitest');
const TESTER = { username: 'tester', password: 'tester-pass' };
const CASES = [
  { proto: 'svn', repo: 'alpha', root: 'svn://127.0.0.1:13690/alpha/trunk', trust: false },
  { proto: 'https', repo: 'beta', root: 'https://127.0.0.1:18443/svn/beta/trunk', trust: true },
] as const;

const exe = findSvnExe().path;
const ports = [13690, 18443];
const up =
  spawnSync(process.execPath, ['-e', `const n=require('net');let ok=0;for(const p of ${JSON.stringify(ports)}){const s=n.connect({host:'127.0.0.1',port:p,timeout:1500});s.on('connect',()=>{s.destroy();if(++ok===${ports.length})process.exit(0)});s.on('timeout',()=>process.exit(1));s.on('error',()=>process.exit(1));}`], { timeout: 10_000 }).status === 0;
const enabled = !!exe && up;
if (!enabled) console.warn('[test:svn] conflict tests SKIPPED: servers or svn.exe unavailable');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const L = (...l: string[]): string => l.map((x) => x + '\n').join('');
const rd = (p: string): string => fs.readFileSync(p, 'utf8');
const wr = (p: string, s: string): void => fs.writeFileSync(p, s);

describe.skipIf(!enabled)('conflicts against local servers', () => {
  const raw = new SvnClient(new SvnLocator(() => '', () => ({ path: exe, tried: [] })), undefined, silent, () => 60_000);

  afterAll(() => rmTree(BASE));
  beforeAll(() => {
    const appdata = path.join(BASE, 'appdata');
    fs.mkdirSync(appdata, { recursive: true });
    process.env.APPDATA = appdata;
    fs.mkdirSync(BASE, { recursive: true });
  });

  describe.each(CASES)('$repo over $proto', ({ proto, repo, root, trust }) => {
    const creds: Credentials = { ...TESTER, trustServerCert: trust };
    const folder = `conflict-vitest-${Date.now()}-${proto}`;
    const url = `${root}/${folder}`;
    const wc1 = path.join(BASE, `${repo}-${proto}`, 'wc1');
    const wc2 = path.join(BASE, `${repo}-${proto}`, 'wc2');
    const client = new Proxy(raw, {
      get(t, k) {
        if (k === 'run') return (a: string[], o = {}) => t.run(a, { ...o, credentials: creds, repoName: undefined });
        if (k === 'status') return (p: string, o = {}) => t.status(p, { ...o, credentials: creds, repoName: undefined });
        return Reflect.get(t, k) as unknown;
      },
    }) as SvnClient;
    const entry: RepoEntry = { name: repo, serverUrl: url, localFolder: wc1, ...TESTER, trustServerCert: trust };
    const c: ConflictCtx & { tmpDir: string } = { client, repo: entry, tmpDir: path.join(BASE, 'tmp') };
    const svn = (cwd: string, ...a: string[]) => client.run(a, { cwd });
    const p1 = (n: string): string => path.join(wc1, n);
    const p2 = (n: string): string => path.join(wc2, n);
    const items = async () => {
      const { entries } = await client.status(wc1);
      return buildItems(repo, entries, new Map(), (p) => path.resolve(wc1, p));
    };
    const statusOf = async (n: string) => (await client.status(p1(n))).entries.find((e) => path.resolve(e.path) === path.resolve(p1(n)));

    const TEXT_FILES = ['t-edit.txt', 't-mf.txt', 't-tf.txt', 't-mc.txt', 't-tc.txt', 't-base.txt'];
    const baseText = L('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h');
    const mineText = L('a', 'B1', 'c', 'D1', 'e', 'f', 'g', 'h');
    const theirsText = L('a', 'B2', 'c', 'd', 'e', 'f', 'G2', 'h');

    beforeAll(async () => {
      await client.run(['mkdir', '-m', 'conflict test folder', '--', url]);
      for (const wc of [wc1, wc2]) await client.run(['checkout', '--', url, wc]);
      for (const f of TEXT_FILES) wr(p1(f), baseText);
      wr(p1('prop.txt'), 'p\n');
      wr(p1('tree-edit.txt'), L('1', '2', '3'));
      wr(p1('tree-del.txt'), L('1', '2', '3'));
      wr(p1('tree-del2.txt'), L('1', '2', '3'));
      wr(p1('tree-keepdel.txt'), L('1', '2', '3'));
      await svn(wc1, 'add', '--force', '--', '.');
      await svn(wc1, 'propset', 'k', 'base', 'prop.txt');
      await svn(wc1, 'commit', '-m', 'seed');
      await svn(wc2, 'update');
      // incoming (wc2)
      for (const f of TEXT_FILES) wr(p2(f), theirsText);
      await svn(wc2, 'propset', 'k', 'theirs-value', 'prop.txt');
      await svn(wc2, 'delete', 'tree-edit.txt');
      wr(p2('tree-del.txt'), L('1', 'incoming', '3'));
      wr(p2('tree-keepdel.txt'), L('1', 'incoming', '3'));
      await svn(wc2, 'delete', 'tree-del2.txt');
      wr(p2('add-add.txt'), 'theirs add\n');
      await svn(wc2, 'add', 'add-add.txt');
      await svn(wc2, 'commit', '-m', 'incoming');
      // local (wc1)
      for (const f of TEXT_FILES) wr(p1(f), mineText);
      await svn(wc1, 'propset', 'k', 'mine-value', 'prop.txt');
      wr(p1('tree-edit.txt'), L('1', 'local', '3'));
      await svn(wc1, 'delete', 'tree-del.txt');
      await svn(wc1, 'delete', 'tree-keepdel.txt');
      wr(p1('tree-del2.txt'), L('1', 'local', '3'));
      wr(p1('add-add.txt'), 'mine add\n');
      await svn(wc1, 'add', 'add-add.txt');
      await client.run(['update', '--accept', 'postpone'], { cwd: wc1 });
    });

    afterAll(async () => {
      await client.run(['delete', '-m', 'cleanup conflict test', '--', url]).catch(() => undefined);
      spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', path.join(BASE, `${repo}-${proto}`)]);
    });

    it('lists text, property and tree conflicts from svn status', async () => {
      const conflicted = conflictedItems(await items());
      const by = new Map(conflicted.map((i) => [path.basename(i.path), conflictKinds(i)]));
      for (const f of TEXT_FILES) expect(by.get(f)).toContain('text');
      expect(by.get('prop.txt')).toEqual(['property']);
      expect(by.get('tree-edit.txt')).toContain('tree');
      expect(by.get('tree-del.txt')).toContain('tree');
      expect(by.get('add-add.txt')).toContain('tree');
    });

    it('reads conflict info from svn info --xml', async () => {
      const [t, pr, tr, tr2] = await loadConflictInfo(c, [p1('t-edit.txt'), p1('prop.txt'), p1('tree-edit.txt'), p1('tree-del.txt')]);
      expect(t.text?.mineFile && fs.existsSync(t.text.mineFile)).toBe(true);
      expect(pr.property?.prejFile && fs.existsSync(pr.property.prejFile)).toBe(true);
      expect(tr.tree).toMatchObject({ reason: 'edit', action: 'delete', operation: 'update', kind: 'file' });
      expect(tr2.tree).toMatchObject({ reason: 'delete', action: 'edit' });
      expect(treeAdvice(tr.tree!).summary).toMatch(/local file edit, incoming file delete/i);
    });

    it('merges base/mine/theirs from the svn conflict files: auto merges plus one conflict, then resolves', async () => {
      const [info] = await loadConflictInfo(c, [p1('t-edit.txt')]);
      const inputs = await loadTextInputs(info);
      expect(inputs.source).toBe('conflict-files');
      expect(inputs.base).toBe(baseText);
      expect(inputs.mine).toBe(mineText);
      expect(inputs.theirs).toBe(theirsText);
      const m = merge3(inputs.base, inputs.mine, inputs.theirs);
      expect(m.conflicts).toHaveLength(1);
      expect(buildResult(m, ['mine']).text).toBe(L('a', 'B1', 'c', 'D1', 'e', 'f', 'G2', 'h'));
      const r = buildResult(m, ['mine-theirs']);
      expect(r.text).toBe(L('a', 'B1', 'B2', 'c', 'D1', 'e', 'f', 'G2', 'h'));
      wr(p1('t-edit.txt'), encodeText(r.text, inputs.encoding).bytes.toString('utf8'));
      const out = await resolvePaths(c, [p1('t-edit.txt')], 'working');
      expect(out.failed).toEqual([]);
      expect(rd(p1('t-edit.txt'))).toBe(r.text);
      const st = await statusOf('t-edit.txt');
      expect(st?.item).toBe('modified');
      expect(fs.existsSync(p1('t-edit.txt.mine'))).toBe(false);
    });

    it('resolves several files at once with each --accept choice', async () => {
      const one = async (file: string, accept: Parameters<typeof resolvePaths>[2]): Promise<string> => {
        const out = await resolvePaths(c, [p1(file)], accept);
        expect(out.failed).toEqual([]);
        expect((await statusOf(file))?.item).not.toBe('conflicted');
        return rd(p1(file));
      };
      expect(await one('t-mf.txt', 'mine-full')).toBe(mineText);
      expect(await one('t-tf.txt', 'theirs-full')).toBe(theirsText);
      expect(await one('t-mc.txt', 'mine-conflict')).toBe(L('a', 'B1', 'c', 'D1', 'e', 'f', 'G2', 'h'));
      expect(await one('t-tc.txt', 'theirs-conflict')).toBe(L('a', 'B2', 'c', 'D1', 'e', 'f', 'G2', 'h'));
      expect(await one('t-base.txt', 'base')).toBe(baseText);
    });

    it('reports an inapplicable option on a tree conflict instead of throwing', async () => {
      const out = await resolvePaths(c, [p1('tree-del2.txt'), p1('tree-del.txt')], 'theirs-full');
      expect(out.resolved).toEqual([]);
      expect(out.failed.map((f) => path.basename(f.path)).sort()).toEqual(['tree-del.txt', 'tree-del2.txt']);
      expect(out.failed[0].message).toMatch(/does not apply/);
    });

    it('resolves a property conflict with a chosen value', async () => {
      const [info] = await loadConflictInfo(c, [p1('prop.txt')]);
      const prej = await readPrej(info);
      expect(prej).toContain("property 'k'");
      expect(await conflictedProperties(c, info, prej)).toEqual(['k']);
      expect(await readPropertyValues(c, info, 'k')).toEqual({ name: 'k', base: 'base', mine: 'mine-value', theirs: 'theirs-value' });
      await applyProperty(c, info.path, 'k', 'merged-value');
      await resolvePaths(c, [info.path], 'working');
      const v = await client.run(['propget', '--strict', 'k', '--', p1('prop.txt')]);
      expect(v.text).toBe('merged-value');
      expect((await statusOf('prop.txt'))?.props).toBe('modified');
    });

    it('tree: local edit vs incoming delete: keep local (becomes an add)', async () => {
      const [info] = await loadConflictInfo(c, [p1('tree-edit.txt')]);
      const keep = treeAdvice(info.tree!).options.find((o) => o.id === 'keep-local')!;
      await runTreeSteps(c, info.path, keep.steps, false);
      expect(rd(p1('tree-edit.txt'))).toBe(L('1', 'local', '3'));
      const st = await statusOf('tree-edit.txt');
      expect(st?.treeConflicted).toBeFalsy();
      expect(st?.item).toBe('added');
    });

    it('tree: local delete vs incoming edit: restore with the incoming change, and keep the delete', async () => {
      const [a, b] = await loadConflictInfo(c, [p1('tree-del.txt'), p1('tree-keepdel.txt')]);
      const restore = treeAdvice(a.tree!).options.find((o) => o.id === 'accept-incoming')!;
      await runTreeSteps(c, a.path, restore.steps, false);
      expect(rd(p1('tree-del.txt'))).toBe(L('1', 'incoming', '3'));
      expect((await statusOf('tree-del.txt'))?.treeConflicted).toBeFalsy();
      const keep = treeAdvice(b.tree!).options.find((o) => o.id === 'keep-delete')!;
      await runTreeSteps(c, b.path, keep.steps, false);
      expect((await statusOf('tree-keepdel.txt'))?.item).toBe('deleted');
      expect((await statusOf('tree-keepdel.txt'))?.treeConflicted).toBeFalsy();
    });

    it('tree: local edit vs incoming delete: accept the delete removes the item', async () => {
      const [info] = await loadConflictInfo(c, [p1('tree-del2.txt')]);
      expect(info.tree).toMatchObject({ reason: 'edit', action: 'delete' });
      const accept = treeAdvice(info.tree!).options.find((o) => o.id === 'accept-delete')!;
      await runTreeSteps(c, info.path, accept.steps, false);
      expect(fs.existsSync(p1('tree-del2.txt'))).toBe(false);
      expect((await items()).some((i) => path.basename(i.path) === 'tree-del2.txt' && conflictKinds(i).length)).toBe(false);
    });

    it('tree: add vs add: take the incoming item', async () => {
      const [info] = await loadConflictInfo(c, [p1('add-add.txt')]);
      expect(info.tree).toMatchObject({ reason: 'add', action: 'add' });
      const take = treeAdvice(info.tree!).options.find((o) => o.id === 'take-incoming-add')!;
      await runTreeSteps(c, info.path, take.steps, false);
      expect(rd(p1('add-add.txt'))).toBe('theirs add\n');
      expect((await statusOf('add-add.txt'))?.treeConflicted).toBeFalsy();
    });

    it('no conflicts are left', async () => {
      const left = conflictedItems(await items()).map((i) => path.basename(i.path));
      expect(left).toEqual([]);
    });
  });
});

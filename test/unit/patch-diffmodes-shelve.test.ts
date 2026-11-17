import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Layout } from '../../src/branch/model';
import { pairFor, parseDiffSummary, refRootOf, samePathIn, summarizeArgs, type FolderMode } from '../../src/diffmodes/model';
import { buildPatchArgs, parsePatchOutput, stripPath } from '../../src/patch/model';
import { planEntry, repoRelativePrefix, rewriteGitPaths } from '../../src/patch/create';
import { applyFilePatch, parseUnifiedDiff, PatchApplyError } from '../../src/patch/parse';
import { unifiedFileDiff } from '../../src/patch/unified';
import { parseNativeList, parseShelfMeta, resolveBackend, slug, validateShelfName } from '../../src/shelve/model';
import { ShelfStore } from '../../src/shelve/store';

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function roundTrip(oldText: string, newText: string, context = 3): void {
  const diff = unifiedFileDiff('a/b.txt', oldText, newText, { context, oldLabel: '(revision 3)', newLabel: '(working copy)' });
  if (oldText === newText) {
    expect(diff).toBe('');
    return;
  }
  const files = parseUnifiedDiff(diff);
  expect(files).toHaveLength(1);
  expect(files[0].path).toBe('a/b.txt');
  expect(applyFilePatch(oldText, files[0])).toBe(newText);
  expect(applyFilePatch(newText, files[0], { reverse: true })).toBe(oldText);
}

describe('unified diff generator', () => {
  it('writes svn style headers and hunks', () => {
    const d = unifiedFileDiff('src/f.txt', 'a\nb\nc\n', 'a\nB\nc\nd\n', { oldLabel: '(revision 7)', newLabel: '(working copy)' });
    expect(d).toBe(
      ['Index: src/f.txt', '='.repeat(67), '--- src/f.txt\t(revision 7)', '+++ src/f.txt\t(working copy)', '@@ -1,3 +1,4 @@', ' a', '-b', '+B', ' c', '+d', ''].join('\n'),
    );
  });
  it('uses single-line ranges like svn and 0-count starts for pure additions', () => {
    expect(unifiedFileDiff('f', 'x\n', 'y\n', { context: 0 })).toContain('@@ -1 +1 @@');
    expect(unifiedFileDiff('f', '', 'y\nz\n', { oldLabel: '(nonexistent)' })).toContain('@@ -0,0 +1,2 @@');
    expect(unifiedFileDiff('f', 'y\nz\n', '', { newLabel: '(nonexistent)' })).toContain('@@ -1,2 +0,0 @@');
  });
  it('marks a missing final newline', () => {
    const d = unifiedFileDiff('f', 'a\nb', 'a\nb\n');
    expect(d).toContain('-b\n\\ No newline at end of file\n+b\n');
  });
  it('honours the context setting and merges nearby hunks', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const edited = lines.slice();
    edited[5] = 'X';
    edited[8] = 'Y';
    edited[30] = 'Z';
    const old = lines.join('\n') + '\n';
    const neu = edited.join('\n') + '\n';
    expect((unifiedFileDiff('f', old, neu, { context: 3 }).match(/^@@/gm) ?? []).length).toBe(2);
    expect((unifiedFileDiff('f', old, neu, { context: 0 }).match(/^@@/gm) ?? []).length).toBe(3);
    expect((unifiedFileDiff('f', old, neu, { context: 30 }).match(/^@@/gm) ?? []).length).toBe(1);
  });
  it('round-trips fixed cases (generate, parse, apply, reverse)', () => {
    roundTrip('a\nb\nc\n', 'a\nb\nc\nd\n');
    roundTrip('', 'one\ntwo\n');
    roundTrip('one\ntwo\n', '');
    roundTrip('a\nb', 'a\nb\n');
    roundTrip('a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n');
    roundTrip('a\nb\nc\n', 'a\r\nb\r\nc\r\n');
    roundTrip('x\n\n\ny\n', 'x\ny\n', 0);
    roundTrip('same\n', 'same\n');
    roundTrip('tab\there  \nend\n', 'tab\there\nend\n', 1);
  });
  it('round-trips 300 random edits at several context sizes', () => {
    const r = rng(42);
    const pool = ['', '}', '{', 'foo();', 'bar();', 'if (x) {', '  return 1;', 'const a = 1;', '// c', 'x'];
    for (let n = 0; n < 300; n++) {
      const mk = (): string[] => Array.from({ length: Math.floor(r() * 25) }, () => pool[Math.floor(r() * pool.length)] + (r() < 0.1 ? ' ' : ''));
      const a = mk();
      const b = a.slice();
      for (let k = Math.floor(r() * 6); k > 0; k--) {
        const i = Math.floor(r() * (b.length + 1));
        const op = r();
        if (op < 0.4) b.splice(i, 0, pool[Math.floor(r() * pool.length)]);
        else if (op < 0.7) b.splice(i, 1);
        else if (i < b.length) b[i] = pool[Math.floor(r() * pool.length)] + '!';
      }
      const eol = r() < 0.3 ? '\r\n' : '\n';
      const join = (l: string[]): string => (l.length ? l.join(eol) + (r() < 0.9 ? eol : '') : '');
      roundTrip(join(a), join(b), [0, 1, 3, 7][n % 4]);
    }
  });
  it('apply fails with PatchApplyError when the file changed', () => {
    const fp = parseUnifiedDiff(unifiedFileDiff('f', 'a\nb\nc\n', 'a\nX\nc\n'))[0];
    expect(() => applyFilePatch('totally\ndifferent\n', fp)).toThrow(PatchApplyError);
  });
  it('applies with a line offset', () => {
    const fp = parseUnifiedDiff(unifiedFileDiff('f', 'a\nb\nc\n', 'a\nX\nc\n'))[0];
    expect(applyFilePatch('new1\nnew2\na\nb\nc\n', fp)).toBe('new1\nnew2\na\nX\nc\n');
  });
});

describe('unified diff parser', () => {
  it('reads svn output with CRLF headers, added and deleted files, and binary markers', () => {
    const t = [
      'Index: f.txt\r\n===\r\n--- f.txt\t(revision 3)\r\n+++ f.txt\t(working copy)\r\n@@ -1,3 +1,4 @@\r\n a\n-b\n+B\n c\n+d\n',
      'Index: new.txt\r\n===\r\n--- new.txt\t(nonexistent)\r\n+++ new.txt\t(working copy)\r\n@@ -0,0 +1 @@\r\n+hi\n',
      'Index: gone.txt\r\n===\r\n--- gone.txt\t(revision 3)\r\n+++ gone.txt\t(nonexistent)\r\n@@ -1 +0,0 @@\r\n-bye\n',
      'Index: img.png\r\n===\r\nCannot display: file marked as binary type.\r\n',
    ].join('');
    const f = parseUnifiedDiff(t);
    expect(f.map((x) => [x.path, x.isNew, x.isDelete, x.binary, x.hunks.length])).toEqual([
      ['f.txt', false, false, false, 1],
      ['new.txt', true, false, false, 1],
      ['gone.txt', false, true, false, 1],
      ['img.png', false, false, true, 0],
    ]);
    expect(applyFilePatch('a\nb\nc\n', f[0])).toBe('a\nB\nc\nd\n');
    expect(applyFilePatch('', f[1])).toBe('hi\n');
  });
  it('reads git style diffs', () => {
    const f = parseUnifiedDiff('diff --git a/x/y.txt b/x/y.txt\nindex 1..2 100644\n--- a/x/y.txt\n+++ b/x/y.txt\n@@ -1 +1 @@\n-a\n+b\n');
    expect(f[0].path).toBe('x/y.txt');
    expect(applyFilePatch('a\n', f[0])).toBe('b\n');
  });
});

describe('svn patch helpers', () => {
  it('builds arguments', () => {
    expect(buildPatchArgs({ patchFile: 'p.diff' })).toEqual(['patch', '--', 'p.diff']);
    expect(buildPatchArgs({ patchFile: 'p.diff', dryRun: true, reverse: true, strip: 2 })).toEqual(['patch', '--dry-run', '--reverse-diff', '--strip', '2', '--', 'p.diff']);
  });
  it('parses output with offsets, rejects, skips and merges', () => {
    const o = parsePatchOutput(
      ['U         a.txt', '>         applied hunk @@ -3,2 +3,2 @@ with offset 2', 'C         b.txt', '>         rejected hunk @@ -1,3 +1,4 @@', 'A         dir/new.txt', 'G         c.txt', '>         hunk @@ -1,3 +1,4 @@ already applied', "Skipped missing target: 'gone.txt'", 'Summary of conflicts:', '  Text conflicts: 1', ''].join('\n'),
    );
    expect(o.entries.map((e) => [e.action, e.path])).toEqual([['U', 'a.txt'], ['C', 'b.txt'], ['A', 'dir/new.txt'], ['G', 'c.txt']]);
    expect(o.conflicts).toEqual(['b.txt']);
    expect(o.rejectedHunks).toBe(1);
    expect(o.skipped).toEqual(['gone.txt']);
    expect(o.entries[0].notes[0]).toContain('offset 2');
  });
  it('strips path components', () => {
    expect(stripPath('a/b/c.txt', 1)).toBe('b/c.txt');
    expect(stripPath('a\\b\\c.txt', 2)).toBe('c.txt');
  });
  it('plans which generator handles an entry', () => {
    const base = { item: 'modified', props: 'none', isDir: false };
    expect(planEntry(base).how).toBe('engine');
    expect(planEntry({ ...base, props: 'modified' }).how).toBe('svn');
    expect(planEntry({ ...base, item: 'added', copied: true }).how).toBe('svn');
    expect(planEntry({ ...base, item: 'unversioned' }).how).toBe('skip');
    expect(planEntry({ ...base, item: 'normal', props: 'modified', isDir: true }).how).toBe('svn');
    expect(planEntry({ ...base, isDir: true }).how).toBe('skip');
    expect(planEntry({ ...base, treeConflicted: true }).how).toBe('skip');
  });
});

describe('svn diff --git path rewriting', () => {
  it('computes the repo-relative prefix svn prints', () => {
    expect(repoRelativePrefix('svn://h/r/proj/trunk', 'svn://h/r')).toBe('proj/trunk/');
    expect(repoRelativePrefix('svn://h/r/my%20proj/', 'svn://h/r')).toBe('my proj/');
    expect(repoRelativePrefix('svn://h/r', 'svn://h/r')).toBe('');
  });
  it('rewrites header lines only', () => {
    const d = ['Index: a.txt', '===', 'diff --git a/proj/trunk/a.txt b/proj/trunk/a.txt', '--- a/proj/trunk/a.txt\t(revision 1)', '+++ b/proj/trunk/a.txt\t(working copy)', '@@ -1 +1 @@', '-a/proj/trunk/a.txt', '+x', '', 'Property changes on: proj/trunk/a.txt', ''].join('\n');
    const r = rewriteGitPaths(d, 'proj/trunk/');
    expect(r).toContain('diff --git a/a.txt b/a.txt');
    expect(r).toContain('+++ b/a.txt\t(working copy)');
    expect(r).toContain('-a/proj/trunk/a.txt');
    expect(r).toContain('Property changes on: a.txt');
    expect(rewriteGitPaths(d, '')).toBe(d);
  });
});

describe('diff mode argument builders', () => {
  it('builds summarize arguments per mode', () => {
    expect(summarizeArgs({ mode: 'base' })).toEqual(['diff', '--summarize', '--', '.']);
    expect(summarizeArgs({ mode: 'head' })).toEqual(['diff', '--summarize', '-r', 'HEAD', '--', '.']);
    expect(summarizeArgs({ mode: 'rev', rev: 12 }, 'sub')).toEqual(['diff', '--summarize', '-r', '12', '--', 'sub']);
    expect(summarizeArgs({ mode: 'urls', oldUrl: 'svn://h/r/trunk/', oldRev: 5, newUrl: 'svn://h/r/branches/b', newRev: 'HEAD' })).toEqual([
      'diff', '--summarize', '--old', 'svn://h/r/trunk@5', '--new', 'svn://h/r/branches/b@HEAD',
    ]);
  });
  const xml = `<?xml version="1.0"?><diff><paths>
<path props="none" kind="file" item="modified">svn://h/r/branches/b/src/a%20b.txt</path>
<path props="none" kind="file" item="added">svn://h/r/branches/b/n.txt</path>
<path item="none" props="modified" kind="dir">svn://h/r/branches/b</path></paths></diff>`;
  const urls: FolderMode = { mode: 'urls', oldUrl: 'svn://h/r/trunk', oldRev: 5, newUrl: 'svn://h/r/branches/b', newRev: 'HEAD' };
  it('parses a URL summary into root-relative entries', () => {
    const e = parseDiffSummary(xml, urls);
    expect(e.map((x) => [x.item, x.kind, x.rel])).toEqual([['modified', 'file', 'src/a%20b.txt'], ['added', 'file', 'n.txt'], ['none', 'dir', '']]);
    expect(parseDiffSummary('<diff><paths></paths></diff>', urls)).toEqual([]);
    const one = parseDiffSummary('<diff><paths><path props="none" kind="file" item="modified">f.txt</path></paths></diff>', { mode: 'base' });
    expect(one).toEqual([{ item: 'modified', props: 'none', kind: 'file', rel: 'f.txt' }]);
  });
  it('pairs sources per mode and item', () => {
    const [m, a] = parseDiffSummary(xml, urls);
    expect(pairFor(urls, 'R', '', m)).toMatchObject({ left: { kind: 'rev', target: 'svn://h/r/trunk/src/a%20b.txt@5', rev: 5 }, right: { kind: 'rev', target: 'svn://h/r/branches/b/src/a%20b.txt@HEAD', rev: 'HEAD' } });
    expect(pairFor(urls, 'R', '', a).left).toMatchObject({ kind: 'text', text: '' });
    const root = path.resolve('wc');
    const e = { item: 'modified', props: 'none', kind: 'file', rel: 'd/f.txt' };
    expect(pairFor({ mode: 'base' }, 'R', root, e)).toMatchObject({ right: { kind: 'rev', rev: 'BASE' }, left: { kind: 'local', fsPath: path.join(root, 'd', 'f.txt') }, editableSide: 'left' });
    expect(pairFor({ mode: 'head' }, 'R', root, e)).toMatchObject({ left: { kind: 'local' }, right: { kind: 'rev', rev: 'HEAD' }, editableSide: 'left' });
    expect(pairFor({ mode: 'rev', rev: 9 }, 'R', root, { ...e, item: 'added' })).toMatchObject({ right: { kind: 'text' } });
    expect(pairFor({ mode: 'head' }, 'R', root, { ...e, item: 'deleted' })).toMatchObject({ left: { kind: 'text' }, right: { kind: 'rev' } });
  });
  it('maps a path onto another branch', () => {
    const layout: Layout = { root: 'svn://h/r', base: 'svn://h/r/p', trunk: 'svn://h/r/p/trunk', branches: 'svn://h/r/p/branches', tags: 'svn://h/r/p/tags', kind: 'branch', name: 'b1' };
    expect(refRootOf(layout)).toBe('svn://h/r/p/branches/b1');
    expect(samePathIn('svn://h/r/p/branches/b1/src/x.ts', layout, 'svn://h/r/p/trunk')).toBe('svn://h/r/p/trunk/src/x.ts');
    expect(samePathIn('svn://h/r/p/other/x', { ...layout, kind: 'other', name: undefined }, 'svn://h/r/p/trunk')).toBeUndefined();
  });
});

describe('shelf metadata and store', () => {
  it('validates names and resolves the backend', () => {
    expect(validateShelfName('fix-login_2')).toBeUndefined();
    for (const bad of ['', ' ', 'a b', '-x', '.x', 'a/b', 'x'.repeat(65)]) expect(validateShelfName(bad)).toBeTruthy();
    expect(resolveBackend('auto', true)).toBe('native');
    expect(resolveBackend('auto', false)).toBe('patch');
    expect(resolveBackend('patch', true)).toBe('patch');
    expect(() => resolveBackend('native', false)).toThrow(/not available/);
  });
  it('parses the native shelf list', () => {
    const l = parseNativeList('sh1                            version 1, 0 minutes ago, 1 path changed\n msg\nsh2                            no versions\nsh3  version 2, 5 hours ago, 12 paths changed\n first line\nsecond line\n');
    expect(l).toEqual([
      { name: 'sh1', version: 1, age: '0 minutes', paths: 1, message: 'msg', broken: false },
      { name: 'sh2', message: '', broken: true },
      { name: 'sh3', version: 2, age: '5 hours', paths: 12, message: 'first line', broken: false },
    ]);
  });
  it('validates stored metadata', () => {
    const m = parseShelfMeta(JSON.stringify({ format: 1, name: 'n', message: 'm', createdAt: 'x', repoName: 'r', files: [{ path: 'a', status: 'added', binary: true }, { path: 'b', status: 'weird' }] }));
    expect(m.files).toEqual([{ path: 'a', status: 'added', binary: true }, { path: 'b', status: 'modified', binary: false }]);
    expect(() => parseShelfMeta('{}')).toThrow();
    expect(slug('a b/c')).not.toBe(slug('a_b/c'));
  });
  it('stores, lists, reads and deletes patch shelves with binaries', async () => {
    const root = fs.mkdtempSync(path.join(process.env.SVN_TEST_TMP ?? (fs.existsSync('F:\\TrashCache') ? 'F:\\TrashCache' : os.tmpdir()), 'shelf-store-'));
    try {
      const src = path.join(root, 'bin.dat');
      fs.writeFileSync(src, Buffer.from([0, 1, 2, 255]));
      const store = new ShelfStore(path.join(root, 'shelves'));
      const meta = { format: 1 as const, name: 's1', message: 'hi', createdAt: '2025-01-01T00:00:00Z', repoName: 'My Repo', files: [{ path: 'd/bin.dat', status: 'modified' as const, binary: true }] };
      await store.write(meta, Buffer.from('patch'), new Map([['d/bin.dat', src]]));
      await store.write({ ...meta, name: 's2', createdAt: '2025-02-01T00:00:00Z' }, Buffer.alloc(0), new Map());
      expect((await store.list('My Repo')).map((m) => m.name)).toEqual(['s2', 's1']);
      expect(await store.list('Other')).toEqual([]);
      expect((await store.readPatch('My Repo', 's1')).toString()).toBe('patch');
      expect([...fs.readFileSync(store.filePath('My Repo', 's1', 'd/bin.dat'))]).toEqual([0, 1, 2, 255]);
      await store.delete('My Repo', 's1');
      expect(await store.exists('My Repo', 's1')).toBe(false);
      expect((await store.list('My Repo')).map((m) => m.name)).toEqual(['s2']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});


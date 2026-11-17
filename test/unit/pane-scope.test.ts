import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IncomingService, StatusSource } from '../../src/incoming/service';
import { focusFolder, pickScope } from '../../src/incoming/scope';
import { bulkConfirmText } from '../../src/util/bulkConfirm';
import { DIRECTIONS, MARKS, iconFile, paneIcon } from '../../src/pane/icons';
import { buildTree, parseViewMode } from '../../src/pane/tree';
import type { ChangeItem } from '../../src/incoming/model';
import type { RepoEntry } from '../../src/repos/model';

const W = { platform: 'win32' as const };
const P = { platform: 'posix' as const };

describe('focusFolder and pickScope', () => {
  const repos = [
    { name: 'sites', localFolder: 'C:\\sites' },
    { name: 'inner', localFolder: 'C:\\sites\\vendor' },
    { name: 'other', localFolder: 'C:\\other' },
  ];
  it('picks the working copy containing the opened folder and scopes to that folder', () => {
    expect(pickScope(repos, 'C:\\sites\\visp2', W)).toEqual({ name: 'sites', target: 'C:\\sites\\visp2' });
    expect(pickScope(repos, 'c:\\SITES\\visp2\\', W)?.name).toBe('sites');
    expect(pickScope(repos, 'C:\\sites', W)).toEqual({ name: 'sites', target: 'C:\\sites' });
  });
  it('the innermost working copy wins', () => {
    expect(pickScope(repos, 'C:\\sites\\vendor\\lib', W)?.name).toBe('inner');
  });
  it('a folder above a working copy takes that working copy; never more than one', () => {
    expect(pickScope([repos[2]], 'C:\\', W)).toEqual({ name: 'other', target: 'C:\\other' });
    expect(pickScope(repos, 'C:\\', W)).toBeDefined();
  });
  it('no match gives no repo (welcome view)', () => {
    expect(pickScope(repos, 'D:\\elsewhere', W)).toBeUndefined();
    expect(pickScope(repos, 'C:\\sitesX', W)).toBeUndefined();
    expect(pickScope(repos, undefined, W)).toBeUndefined();
  });
  it('multi-root follows the active file, falling back to the first folder', () => {
    expect(focusFolder(['/a', '/b'], '/b/x/y.txt', P)).toBe('/b');
    expect(focusFolder(['/a', '/b'], '/c/y.txt', P)).toBe('/a');
    expect(focusFolder(['/a', '/b'], undefined, P)).toBe('/a');
    expect(focusFolder(['/a', '/a/b'], '/a/b/f', P)).toBe('/a/b');
    expect(focusFolder([], '/a/f', P)).toBeUndefined();
  });
});

describe('bulk confirmation text', () => {
  it('states repo, folder and count', () => {
    const u = bulkConfirmText('update', 'sites', 'C:\\sites\\visp2', 3);
    expect(u.action).toBe('Update');
    expect(u.detail).toContain('sites');
    expect(u.detail).toContain('C:\\sites\\visp2');
    expect(u.detail).toContain('3 incoming items');
    const c = bulkConfirmText('commit', 'sites', '/x', 1);
    expect(c.action).toBe('Commit');
    expect(c.detail).toContain('1 outgoing item.');
  });
});

const win = process.platform === 'win32';
const wc = win ? 'C:\\wc' : '/wc';
const p = (rel: string): string => path.join(wc, ...rel.split('/'));
const repo: RepoEntry = { name: 'r', serverUrl: 'svn://x/r', localFolder: wc };

describe('IncomingService scoping', () => {
  it('runs status on each scope path, hides out-of-scope repos and re-checks on scopeChanged', async () => {
    const calls: string[] = [];
    const client: StatusSource = {
      async status(t) {
        calls.push(t);
        return { entries: [{ path: path.join(t, 'f.txt'), item: 'modified', props: 'none', wcLocked: false, revision: 1 }] as never[] };
      },
    };
    const other: RepoEntry = { ...repo, name: 'o', localFolder: win ? 'C:\\other' : '/other' };
    let scope: Record<string, string[]> = { r: [p('visp2')], o: [] };
    const s = new IncomingService(client, () => [repo, other]);
    s.scope = (r) => scope[r.name];
    await s.refresh();
    expect(calls).toEqual([p('visp2')]);
    expect(s.visibleRepos().map((r) => r.name)).toEqual(['r']);
    expect(s.allItems().map((i) => i.path)).toEqual([p('visp2/f.txt')]);
    scope = { r: [p('a'), p('b')], o: [other.localFolder] };
    calls.length = 0;
    s.scopeChanged();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.sort()).toEqual([p('a'), p('b'), other.localFolder].sort());
    expect(s.allItems().map((i) => i.path).sort()).toEqual([p('a/f.txt'), p('b/f.txt'), path.join(other.localFolder, 'f.txt')].sort());
  });
});

const item = (rel: string, over: Partial<ChangeItem> = {}): ChangeItem => ({ repoName: 'r', path: p(rel), item: 'modified', props: 'none', outgoing: true, incoming: false, ...over });

describe('buildTree', () => {
  it('builds folders, compacts single-child chains, folders first', () => {
    const t = buildTree([item('a/b/c/x.txt'), item('a/b/c/y.txt'), item('z.txt'), item('src/m.txt'), item('src/lib/n.txt')], wc);
    expect(t.map((e) => (e.kind === 'folder' ? `d:${e.name}` : 'f'))).toEqual(['d:a/b/c', 'd:src', 'f']);
    const first = t[0];
    expect(first.kind === 'folder' && first.children).toHaveLength(2);
    expect(first.kind === 'folder' && first.path).toBe(p('a/b/c'));
    const src = t[1];
    expect(src.kind === 'folder' && src.children.map((c) => (c.kind === 'folder' ? c.name : 'f'))).toEqual(['lib', 'f']);
    expect(src.kind === 'folder' && src.items).toHaveLength(2);
  });
  it('a changed folder with changed children is one folder node that includes its own item', () => {
    const t = buildTree([item('newdir', { item: 'added' }), item('newdir/a.txt', { item: 'added' })], wc);
    expect(t).toHaveLength(1);
    expect(t[0].kind === 'folder' && t[0].items).toHaveLength(2);
  });
  it('does not merge a folder that has its own item with its sub-folder', () => {
    const t = buildTree([item('d', { item: 'added' }), item('d/e/f.txt')], wc);
    const d = t[0];
    expect(d.kind === 'folder' && d.name).toBe('d');
  });
  it('paths are relative to the scoped folder: first level is "App", not "visp2/App"', () => {
    const t = buildTree([item('visp2/App/a.php'), item('visp2/App/b.php'), item('visp2/lib/c.php'), item('visp2/lib/d.php')], p('visp2'));
    expect(t.map((e) => (e.kind === 'folder' ? e.name : 'f'))).toEqual(['App', 'lib']);
  });
  it('parses the persisted mode', () => {
    expect(parseViewMode('list')).toBe('list');
    expect(parseViewMode(undefined)).toBe('tree');
  });
});

describe('pane icons', () => {
  it('direction follows outgoing / incoming / both', () => {
    expect(paneIcon({ item: 'modified', outgoing: true, incoming: false }).dir).toBe('out');
    expect(paneIcon({ item: 'normal', outgoing: false, incoming: true, repoItem: 'modified' })).toEqual({ dir: 'in', mark: 'none' });
    expect(paneIcon({ item: 'modified', outgoing: true, incoming: true }).dir).toBe('both');
  });
  it('added files combine + with the arrow, in both directions', () => {
    expect(paneIcon({ item: 'added', outgoing: true, incoming: false })).toEqual({ dir: 'out', mark: 'add' });
    expect(paneIcon({ item: 'normal', outgoing: false, incoming: true, repoItem: 'added' })).toEqual({ dir: 'in', mark: 'add' });
  });
  it('conflicted, deleted and unversioned stay distinct', () => {
    const marks = [
      paneIcon({ item: 'conflicted', outgoing: true, incoming: false }),
      paneIcon({ item: 'deleted', outgoing: true, incoming: false }),
      paneIcon({ item: 'unversioned', outgoing: true, incoming: false }),
      paneIcon({ item: 'normal', outgoing: true, incoming: false, treeConflicted: true }),
    ].map((i) => i.mark);
    expect(marks).toEqual(['conflict', 'del', 'unversioned', 'conflict']);
  });
  it('every icon file exists in light and dark', () => {
    const root = path.resolve(__dirname, '..', '..');
    for (const dir of DIRECTIONS) for (const mark of MARKS) for (const theme of ['light', 'dark'] as const) expect(fs.existsSync(path.join(root, iconFile({ dir, mark }, theme)))).toBe(true);
  });
});

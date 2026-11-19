import { afterEach, describe, expect, it } from 'vitest';
import { IncomingService } from '../../src/incoming/service';
import { formatCommitDate, newestEntryFor } from '../../src/incoming/authors';
import { buildItems } from '../../src/incoming/model';
import { LocalIgnoreError, addToList, assertNoLocalIgnored, expandUpdatePaths, isLocalIgnored, localIgnoredAround, skipLocalIgnoredRevert, partitionLocalIgnored, removeFromList, setLocalIgnoreSource } from '../../src/localignore/model';
import { DEFAULT_VISIBILITY, filterItems, parseVisibility, statusText } from '../../src/pane/model';
import { planRevert } from '../../src/wc/model';
import { pathKey } from '../../src/incoming/model';
import { parseLog } from '../../src/svn/xml';
import type { RepoEntry } from '../../src/repos/model';

const win = process.platform === 'win32';
const p = (rel: string): string => (win ? ['C:', 'wc', ...rel.split('/')].join('\\') : `/wc/${rel}`);
const repo: RepoEntry = { name: 'r', serverUrl: 'svn://x/r', localFolder: win ? ['C:', 'wc'].join('\\') : '/wc' };
const st = (path: string, item: string, repoItem?: string) => ({ path, item, props: 'none', wcLocked: false, repoItem, revision: 1 });

afterEach(() => setLocalIgnoreSource(() => []));

describe('local ignore list', () => {
  it('matches the path itself and anything below a listed folder', () => {
    const list = [p('config/app.cfg'), p('secrets')];
    expect(isLocalIgnored(p('config/app.cfg'), list)).toBe(true);
    expect(isLocalIgnored(p('secrets/a/b.txt'), list)).toBe(true);
    expect(isLocalIgnored(p('config/other.cfg'), list)).toBe(false);
    expect(isLocalIgnored(p('secretsX/a'), list)).toBe(false);
  });

  it('add/remove dedupe by path key', () => {
    const l = addToList([p('a')], [p('A'), p('b')]);
    expect(l).toHaveLength(win ? 2 : 3);
    expect(removeFromList(l, [p('b')])).not.toContain(p('b'));
  });

  it('partition splits items', () => {
    const { kept, ignored } = partitionLocalIgnored([{ path: p('a') }, { path: p('b') }], [p('b')]);
    expect(kept.map((i) => i.path)).toEqual([p('a')]);
    expect(ignored.map((i) => i.path)).toEqual([p('b')]);
  });

  it('update-all never targets ignored files: folder expands to incoming items, ignored explicit target dropped', () => {
    const items = [{ path: p('a.txt'), incoming: true }, { path: p('sub/c.txt'), incoming: true }, { path: p('m.txt'), incoming: false }];
    const list = [p('cfg.xml')];
    expect(expandUpdatePaths([repo.localFolder], items, list).sort()).toEqual([p('a.txt'), p('sub/c.txt')].sort());
    expect(expandUpdatePaths([p('cfg.xml')], items, list)).toEqual([]);
    expect(expandUpdatePaths([p('sub')], items, list)).toEqual([p('sub')]);
    expect(expandUpdatePaths([repo.localFolder], items, [])).toEqual([repo.localFolder]);
  });

  it('low-level guard rejects folders containing, or files inside, ignored paths', () => {
    setLocalIgnoreSource(() => [p('cfg.xml')]);
    expect(() => assertNoLocalIgnored([repo.localFolder])).toThrow(LocalIgnoreError);
    expect(() => assertNoLocalIgnored([p('cfg.xml')])).toThrow(LocalIgnoreError);
    expect(() => assertNoLocalIgnored([p('a.txt')])).not.toThrow();
  });

  it('IncomingService keeps ignored items out of items and re-splits on list change', async () => {
    const c = { async status() { return { entries: [st(p('a.txt'), 'modified'), st(p('cfg.xml'), 'modified', 'modified')] }; } };
    const s = new IncomingService(c, () => [repo]);
    let list = [p('cfg.xml')];
    s.isLocalIgnored = (x) => isLocalIgnored(x, list);
    await s.refresh({ remote: true });
    expect(s.allItems().map((i) => i.path)).toEqual([p('a.txt')]);
    expect(s.getState('r')?.ignored.map((i) => i.path)).toEqual([p('cfg.xml')]);
    expect(s.hasIncoming(p('cfg.xml'))).toBe(false);
    list = [];
    s.localIgnoreChanged();
    expect(s.allItems()).toHaveLength(2);
  });
});

describe('pane visibility filter', () => {
  const items = [{ item: 'modified', outgoing: true, incoming: false }, { item: 'unversioned', outgoing: true, incoming: false }, { item: 'ignored', outgoing: false, incoming: false }];
  it('defaults: unversioned shown, ignored hidden', () => {
    expect(filterItems(items, 'all').map((i) => i.item)).toEqual(['modified', 'unversioned']);
  });
  it('toggles', () => {
    expect(filterItems(items, 'all', { unversioned: false, ignored: true }).map((i) => i.item)).toEqual(['modified', 'ignored']);
    expect(filterItems(items, 'incoming', { unversioned: true, ignored: true }).map((i) => i.item)).toEqual(['ignored']);
  });
  it('parses persisted values defensively', () => {
    expect(parseVisibility(undefined)).toEqual(DEFAULT_VISIBILITY);
    expect(parseVisibility({ ignored: true, unversioned: 'x' })).toEqual({ unversioned: true, ignored: true });
  });
  it('buildItems keeps ignored entries, display-only', () => {
    const [i] = buildItems('r', [st(p('x.log'), 'ignored')], new Map(), (q) => q);
    expect(i).toMatchObject({ item: 'ignored', outgoing: false, incoming: false });
    expect(statusText(i)).toContain('Ignored');
  });
});

describe('commit date', () => {
  it('formats local time as YYYY-MM-DD HH:mm:ss', () => {
    const d = new Date(2026, 10, 5, 7, 8, 9);
    expect(formatCommitDate(d.toISOString())).toBe('2026-11-05 07:08:09');
    expect(formatCommitDate('nope')).toBeUndefined();
    expect(formatCommitDate(undefined)).toBeUndefined();
  });
  it('newestEntryFor carries the date', () => {
    const log = parseLog('<log><logentry revision="2"><author>bob</author><date>2026-01-02T03:04:05.000000Z</date><paths><path action="M" kind="file">/t/a.txt</path></paths></logentry></log>');
    expect(newestEntryFor('/t/a.txt', log)).toMatchObject({ author: 'bob', date: '2026-01-02T03:04:05.000000Z' });
  });
});

describe('local ignore list and revert', () => {
  const list = [p('sub/cfg.xml')];
  const cands = [
    { path: p('a.txt'), item: 'modified' },
    { path: p('sub'), item: 'modified', props: 'modified', isDir: true },
    { path: p('sub/cfg.xml'), item: 'modified' },
    { path: p('sub/b.txt'), item: 'modified' },
    { path: p('other'), item: 'modified', props: 'modified', isDir: true },
  ];

  it('drops ignored candidates and stops folders that hold them from reverting recursively', () => {
    const out = skipLocalIgnoredRevert(cands, list);
    expect(out.map((c) => c.path)).not.toContain(p('sub/cfg.xml'));
    expect(out.find((c) => c.path === p('sub'))?.isDir).toBe(false);
    expect(out.find((c) => c.path === p('other'))?.isDir).toBe(true);
    const plan = planRevert(out, new Set(out.map((c) => pathKey(c.path))));
    expect(plan.find((s) => s.path === p('sub'))?.recursive).toBe(false);
    expect(plan.some((s) => isLocalIgnored(s.path, list))).toBe(false);
  });

  it('drops an explicitly targeted ignored folder and everything beneath it', () => {
    const out = skipLocalIgnoredRevert([{ path: p('sub/x/y.txt') }, { path: p('z.txt') }], [p('sub')]);
    expect(out.map((c) => c.path)).toEqual([p('z.txt')]);
  });

  it('localIgnoredAround finds listed paths under or above a target', () => {
    expect(localIgnoredAround([p('sub')], list)).toEqual(list);
    expect(localIgnoredAround([p('sub/cfg.xml/deeper')], list)).toEqual(list);
    expect(localIgnoredAround([p('other')], list)).toEqual([]);
  });
});

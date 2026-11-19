import { describe, expect, it } from 'vitest';
import { aggregateIncoming, buildItems, isIncomingStatus, isOutgoingStatus, isSameOrUnder, remoteMapFrom } from '../../src/incoming/model';
import { isDisplayOnly } from '../../src/pane/icons';
import type { StatusEntry } from '../../src/svn/xml';

const W = { platform: 'win32' } as const;
const abs = (p: string): string => (/^[a-z]:/i.test(p) ? p : `C:\\wc\\${p}`);
const entry = (path: string, item: string, repoItem?: string, extra: Partial<StatusEntry> = {}): StatusEntry => ({ path, item, props: 'none', wcLocked: false, repoItem, ...extra });

describe('status classification', () => {
  it('outgoing statuses', () => {
    for (const s of ['modified', 'added', 'deleted', 'unversioned', 'missing', 'conflicted', 'replaced']) expect(isOutgoingStatus(s, 'none')).toBe(true);
    expect(isOutgoingStatus('normal', 'none')).toBe(false);
    expect(isOutgoingStatus('normal', 'modified')).toBe(true);
    expect(isOutgoingStatus('external', 'none')).toBe(false);
  });
  it('incoming statuses', () => {
    expect(isIncomingStatus('modified', 'none')).toBe(true);
    expect(isIncomingStatus('deleted', undefined)).toBe(true);
    expect(isIncomingStatus(undefined, 'modified')).toBe(true);
    expect(isIncomingStatus('none', 'none')).toBe(false);
    expect(isIncomingStatus(undefined, undefined)).toBe(false);
  });
});

describe('buildItems', () => {
  it('flags outgoing, incoming and both', () => {
    const entries = [entry('a.txt', 'modified'), entry('b.txt', 'normal', 'modified'), entry('c.txt', 'modified', 'modified'), entry('d.txt', 'unversioned'), entry('e.txt', 'normal')];
    const remote = remoteMapFrom(entries, abs, W);
    const items = buildItems('r', entries, remote, abs, W);
    const by = Object.fromEntries(items.map((i) => [i.path.split('\\').pop(), i]));
    expect(by['a.txt']).toMatchObject({ outgoing: true, incoming: false });
    expect(by['b.txt']).toMatchObject({ outgoing: false, incoming: true });
    expect(by['c.txt']).toMatchObject({ outgoing: true, incoming: true });
    expect(by['d.txt']).toMatchObject({ outgoing: true, incoming: false, item: 'unversioned' });
    expect(by['e.txt']).toBeUndefined();
  });
  it('ignored items are display-only: neither outgoing nor incoming, even with props or server changes', () => {
    const entries = [entry('i.log', 'ignored', 'modified', { props: 'modified' })];
    const [i] = buildItems('r', entries, remoteMapFrom(entries, abs, W), abs, W);
    expect(i).toMatchObject({ item: 'ignored', outgoing: false, incoming: false });
    expect(isDisplayOnly(i)).toBe(true);
    expect(isDisplayOnly({ outgoing: true, incoming: false })).toBe(false);
  });
  it('keeps remembered incoming items on a local-only refresh', () => {
    const remote = remoteMapFrom([entry('b.txt', 'normal', 'modified', { revision: 3 })], abs, W);
    const items = buildItems('r', [entry('a.txt', 'modified')], remote, abs, W);
    expect(items.map((i) => i.path).sort()).toEqual(['C:\\wc\\a.txt', 'C:\\wc\\b.txt']);
    expect(items.find((i) => i.path.endsWith('b.txt'))).toMatchObject({ incoming: true, outgoing: false, revision: 3 });
  });
  it('matches remote info case-insensitively on Windows', () => {
    const remote = remoteMapFrom([entry('A.txt', 'normal', 'modified')], abs, W);
    const items = buildItems('r', [entry('a.TXT', 'modified')], remote, abs, W);
    expect(items).toHaveLength(1);
    expect(items[0].incoming && items[0].outgoing).toBe(true);
  });
});

describe('aggregateIncoming', () => {
  it('adds ancestors up to and including the root', () => {
    const out = aggregateIncoming(['C:\\wc\\src\\util\\a.txt'], 'C:\\wc', W);
    expect(out.sort()).toEqual(['C:\\wc', 'C:\\wc\\src', 'C:\\wc\\src\\util', 'C:\\wc\\src\\util\\a.txt'].sort());
  });
  it('deduplicates shared ancestors and does not leak above the root', () => {
    const out = aggregateIncoming(['C:\\wc\\src\\a.txt', 'C:\\wc\\src\\b.txt'], 'C:\\wc', W);
    expect(out).toHaveLength(4);
    expect(out.some((p) => p === 'C:\\')).toBe(false);
  });
  it('works for posix', () => {
    expect(aggregateIncoming(['/wc/a/b.txt'], '/wc', { platform: 'posix' }).sort()).toEqual(['/wc', '/wc/a', '/wc/a/b.txt']);
  });
  it('is empty without incoming items', () => {
    expect(aggregateIncoming([], 'C:\\wc', W)).toEqual([]);
  });
});

describe('isSameOrUnder', () => {
  it('handles prefix lookalikes and case', () => {
    expect(isSameOrUnder('C:\\wc\\src\\a', 'c:\\WC\\src', W)).toBe(true);
    expect(isSameOrUnder('C:\\wc\\srcx\\a', 'C:\\wc\\src', W)).toBe(false);
    expect(isSameOrUnder('C:\\wc\\src', 'C:\\wc\\src\\', W)).toBe(true);
  });
});

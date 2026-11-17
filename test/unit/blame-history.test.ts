import { describe, expect, it } from 'vitest';
import { BlameCache, formatAnnotation, mapBlameToText } from '../../src/blame/model';
import { buildLogArgs, loadPage, matchesFilter, rangeBounds, repoPathToUrl, validateFilter } from '../../src/history/model';
import { sidesForChange } from '../../src/history/service';
import { parseBlame, parseLog, type BlameLine, type LogEntry } from '../../src/svn/xml';

const BLAME_XML = `<?xml version="1.0" encoding="UTF-8"?>
<blame><target path="a.txt">
<entry line-number="1"><commit revision="2"><author>alice</author><date>2025-01-02T10:00:00.000000Z</date></commit></entry>
<entry line-number="2"><commit revision="5"><author>bob</author><date>2025-02-03T11:00:00.000000Z</date></commit></entry>
<entry line-number="3"><commit revision="2"><author>alice</author><date>2025-01-02T10:00:00.000000Z</date></commit></entry>
</target></blame>`;

function bl(...revs: number[]): BlameLine[] {
  return revs.map((r, i) => ({ line: i + 1, revision: r, author: `u${r}`, date: '2025-01-01T00:00:00Z' }));
}

describe('parseBlame', () => {
  it('parses entries in line order', () => {
    const b = parseBlame(BLAME_XML);
    expect(b.map((x) => [x.line, x.revision, x.author])).toEqual([[1, 2, 'alice'], [2, 5, 'bob'], [3, 2, 'alice']]);
    expect(b[1].date).toBe('2025-02-03T11:00:00.000000Z');
  });
  it('tolerates lines without commit and empty files', () => {
    expect(parseBlame('<blame><target path="x"><entry line-number="1"/></target></blame>')).toEqual([{ line: 1, revision: undefined, author: undefined, date: undefined }]);
    expect(parseBlame('<blame><target path="x"/></blame>')).toEqual([]);
  });
});

describe('mapBlameToText', () => {
  const base = 'a\nb\nc\nd\n';
  const blame = bl(1, 2, 3, 4);
  it('is the identity for unchanged text', () => {
    expect(mapBlameToText(blame, base, base).map((m) => m?.revision)).toEqual([1, 2, 3, 4]);
  });
  it('marks inserted lines uncommitted and shifts the rest', () => {
    const cur = 'a\nNEW1\nNEW2\nb\nc\nd\n';
    expect(mapBlameToText(blame, base, cur).map((m) => m?.revision)).toEqual([1, undefined, undefined, 2, 3, 4]);
  });
  it('drops deleted lines and keeps alignment', () => {
    expect(mapBlameToText(blame, base, 'a\nd\n').map((m) => m?.revision)).toEqual([1, 4]);
  });
  it('marks modified lines uncommitted', () => {
    expect(mapBlameToText(blame, base, 'a\nB!\nc\nd\n').map((m) => m?.revision)).toEqual([1, undefined, 3, 4]);
  });
  it('treats an empty current text and missing final newline sanely', () => {
    expect(mapBlameToText(blame, base, '')).toEqual([]);
    expect(mapBlameToText(blame, base, 'a\nb\nc\nd').map((m) => m?.revision)).toEqual([1, 2, 3, 4]);
  });
  it('handles CRLF edits as unchanged', () => {
    expect(mapBlameToText(blame, base, 'a\r\nb\r\nc\r\nd\r\n').map((m) => m?.revision)).toEqual([1, 2, 3, 4]);
  });
});

describe('formatAnnotation', () => {
  it('fills tokens and shows uncommitted', () => {
    const c = { author: 'alice', revision: 12, date: '2025-03-04T05:06:07Z', message: 'Fix the thing\nmore' };
    expect(formatAnnotation('{author} r{rev} {date}', c)).toBe('alice r12 2025-03-04');
    expect(formatAnnotation('{rev}: {message}', c)).toBe('12: Fix the thing');
    expect(formatAnnotation('{rev}: {message}', { ...c, message: 'x'.repeat(100) }, 10)).toBe('12: xxxxxxxxx\u2026');
    expect(formatAnnotation('{author}', undefined)).toBe('uncommitted');
    expect(formatAnnotation('', c)).toBe('alice r12 2025-03-04');
  });
});

describe('BlameCache', () => {
  it('loads once per file+revision, shares in-flight loads, invalidates', async () => {
    const cache = new BlameCache();
    let n = 0;
    const load = () => Promise.resolve({ revision: 3, lines: [], baseText: `v${++n}` });
    const [a, b] = await Promise.all([cache.getOrLoad('C:\\X\\a.txt', 3, load), cache.getOrLoad('c:\\x\\A.txt', 3, load)]);
    expect(a).toBe(b);
    expect(n).toBe(1);
    await cache.getOrLoad('C:\\X\\a.txt', 4, load);
    expect(n).toBe(2);
    cache.invalidate('C:\\X\\a.txt');
    expect(cache.size).toBe(0);
    await cache.getOrLoad('C:\\X\\a.txt', 3, load);
    cache.invalidate();
    expect(cache.size).toBe(0);
  });
  it('bounds its size', async () => {
    const cache = new BlameCache();
    for (let i = 0; i < 60; i++) await cache.getOrLoad(`f${i}`, 1, () => Promise.resolve({ revision: 1, lines: [], baseText: '' }));
    expect(cache.size).toBeLessThanOrEqual(40);
  });
});

function entry(rev: number, author: string, message: string, ...paths: string[]): LogEntry {
  return { revision: rev, author, date: '2025-01-01T00:00:00Z', message, paths: paths.map((p) => ({ action: 'M', path: p })) };
}

describe('log filters', () => {
  it('matches author, text and path case-insensitively', () => {
    const e = entry(3, 'Alice', 'Fix Login bug', '/trunk/src/Login.php');
    expect(matchesFilter(e, {})).toBe(true);
    expect(matchesFilter(e, { author: 'ali' })).toBe(true);
    expect(matchesFilter(e, { author: 'bob' })).toBe(false);
    expect(matchesFilter(e, { text: 'LOGIN' })).toBe(true);
    expect(matchesFilter(e, { path: 'src/login' })).toBe(true);
    expect(matchesFilter(e, { path: 'docs/' })).toBe(false);
    expect(matchesFilter(e, { author: 'alice', text: 'nope' })).toBe(false);
  });
  it('validates input', () => {
    expect(validateFilter({})).toBeUndefined();
    expect(validateFilter({ dateFrom: '2025-02-30x' })).toMatch(/From date/);
    expect(validateFilter({ dateFrom: '2025-03-01', dateTo: '2025-02-01' })).toMatch(/after/);
    expect(validateFilter({ revFrom: 9, revTo: 3 })).toMatch(/greater/);
    expect(validateFilter({ revFrom: 1.5 })).toMatch(/whole/);
  });
  it('builds server-side ranges and arguments', () => {
    expect(rangeBounds({})).toEqual({ top: 'HEAD', bottom: '1' });
    expect(rangeBounds({ revFrom: 4, revTo: 9, dateFrom: '2025-01-01' })).toEqual({ top: '9', bottom: '4' });
    expect(rangeBounds({ dateFrom: '2025-01-01', dateTo: '2025-01-31' })).toEqual({ top: '{2025-01-31T23:59:59}', bottom: '{2025-01-01T00:00:00}' });
    expect(buildLogArgs('p', { stopOnCopy: true }, 50)).toEqual(['log', '-v', '-r', 'HEAD:1', '--limit', '50', '--stop-on-copy', '--', 'p']);
    expect(buildLogArgs('p', { revFrom: 3 }, 20, 10)).toEqual(['log', '-v', '-r', '9:3', '--limit', '20', '--', 'p']);
  });
  it('encodes repository paths into URLs', () => {
    expect(repoPathToUrl('svn://h/r/', '/trunk/a b/c#d.txt')).toBe('svn://h/r/trunk/a%20b/c%23d.txt');
  });
});

describe('loadPage', () => {
  // 100 revisions, newest first; revision n is by 'even' when n is even.
  const all: LogEntry[] = Array.from({ length: 100 }, (_, i) => entry(100 - i, (100 - i) % 2 ? 'odd' : 'even', `m${100 - i}`, '/trunk/f'));
  const fetcher = (calls: Array<[number | undefined, number]> = []) => async (cursor: number | undefined, limit: number) => {
    calls.push([cursor, limit]);
    return all.filter((e) => cursor === undefined || e.revision < cursor).slice(0, limit);
  };

  it('pages without client filters by --limit and cursor', async () => {
    const f = fetcher();
    const p1 = await loadPage(f, {}, 30);
    expect(p1.entries.map((e) => e.revision)[0]).toBe(100);
    expect(p1.entries).toHaveLength(30);
    expect(p1.nextCursor).toBe(71);
    const p2 = await loadPage(f, {}, 30, p1.nextCursor);
    expect(p2.entries[0].revision).toBe(70);
    let cur = p2.nextCursor;
    let total = 60;
    while (cur !== undefined) {
      const p = await loadPage(f, {}, 30, cur);
      total += p.entries.length;
      cur = p.nextCursor;
    }
    expect(total).toBe(100);
  });
  it('scans past non-matching entries until the page is full', async () => {
    const p = await loadPage(fetcher(), { author: 'even' }, 10);
    expect(p.entries).toHaveLength(10);
    expect(p.entries.every((e) => e.author === 'even')).toBe(true);
    expect(p.entries[0].revision).toBe(100);
    expect(p.entries[9].revision).toBe(82);
    expect(p.nextCursor).toBe(82);
    const p2 = await loadPage(fetcher(), { author: 'even' }, 10, p.nextCursor);
    expect(p2.entries[0].revision).toBe(80);
  });
  it('reports exhaustion and handles no matches', async () => {
    const none = await loadPage(fetcher(), { text: 'zzz' }, 10);
    expect(none.entries).toEqual([]);
    expect(none.nextCursor).toBeUndefined();
    const few = await loadPage(fetcher(), { text: 'm9' }, 50);
    expect(few.entries.map((e) => e.revision)).toEqual([99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 9]);
    expect(few.nextCursor).toBeUndefined();
  });
  it('stops at the lower revision bound', async () => {
    const p = await loadPage(fetcher(), { revFrom: 98 }, 10, 100);
    // fake server ignores -r, so a cursor at the bound ends the walk
    expect(p.nextCursor === undefined || p.nextCursor >= 98).toBe(true);
    const end = await loadPage(fetcher(), { revFrom: 98 }, 10, 98);
    expect(end.entries).toEqual([]);
    expect(end.nextCursor).toBeUndefined();
  });
  it('treats an upward range (crossed date bound) as the end', async () => {
    const asc = async () => [entry(4, 'a', 'x'), entry(5, 'a', 'y'), entry(6, 'a', 'z')];
    const p = await loadPage(asc, { dateFrom: '2025-01-01' }, 10, 5);
    expect(p.entries).toEqual([]);
    expect(p.nextCursor).toBeUndefined();
  });
});

describe('parseLog copyfrom and sidesForChange', () => {
  const xml = `<log><logentry revision="7"><author>a</author><date>2025-01-01T00:00:00Z</date><paths>
<path action="A" kind="file" copyfrom-path="/trunk/old.txt" copyfrom-rev="5">/branches/b/new.txt</path>
<path action="M" kind="file">/trunk/m.txt</path>
<path action="D" kind="file">/trunk/d.txt</path>
<path action="A" kind="file">/trunk/fresh.txt</path></paths><msg>hi</msg></logentry></log>`;
  const e = parseLog(xml)[0];
  it('parses copyfrom', () => {
    expect(e.paths[0]).toMatchObject({ copyfromPath: '/trunk/old.txt', copyfromRev: 5 });
    expect(e.paths[1].copyfromPath).toBeUndefined();
  });
  it('chooses rev-1 vs rev sides', () => {
    expect(sidesForChange(e, '/trunk/m.txt')).toEqual({ leftPath: '/trunk/m.txt', leftRev: 6, rightPath: '/trunk/m.txt', rightRev: 7 });
    expect(sidesForChange(e, '/trunk/d.txt')).toEqual({ leftPath: '/trunk/d.txt', leftRev: 6 });
    expect(sidesForChange(e, '/trunk/fresh.txt')).toEqual({ rightPath: '/trunk/fresh.txt', rightRev: 7 });
    expect(sidesForChange(e, '/branches/b/new.txt')).toEqual({ rightPath: '/branches/b/new.txt', rightRev: 7, leftPath: '/trunk/old.txt', leftRev: 5 });
  });
});

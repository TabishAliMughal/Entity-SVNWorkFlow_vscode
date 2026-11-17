import { describe, expect, it } from 'vitest';
import { changelistNames, groupByChangelist, validateChangelistName } from '../../src/changelist/model';
import { CommitEntry, buildPlan, defaultChecked, entryKind, isOutOfDate, pushHistory, sanitizeHistory, validateCommit } from '../../src/commit/selection';
import { parseStatus } from '../../src/svn/xml';
import { contentSecurityPolicy, webviewHtml } from '../../src/util/webviewHtml';

const e = (p: string, item: string, extra: Partial<CommitEntry> = {}): CommitEntry => ({ repoName: 'r', path: `C:\\wc\\${p}`, item, props: 'none', ...extra });

describe('changelist grouping', () => {
  const items = [{ changelist: 'zeta', n: 1 }, { n: 2 }, { changelist: 'Alpha', n: 3 }, { changelist: 'zeta', n: 4 }, { n: 5 }];
  it('puts the default group first, then changelists alphabetically', () => {
    const g = groupByChangelist(items);
    expect(g.map((x) => x.title)).toEqual(['Changes', 'Alpha', 'zeta']);
    expect(g[0].changelist).toBeUndefined();
    expect(g[2].items.map((i) => i.n)).toEqual([1, 4]);
  });
  it('omits an empty default group and can stay flat when unused', () => {
    expect(groupByChangelist([{ changelist: 'a' }]).map((x) => x.title)).toEqual(['a']);
    expect(groupByChangelist([{}, {}], true)).toEqual([]);
    expect(groupByChangelist([{}, {}]).map((x) => x.title)).toEqual(['Changes']);
  });
  it('lists names and validates them', () => {
    expect(changelistNames(items)).toEqual(['Alpha', 'zeta']);
    expect(validateChangelistName('  ')).toBeTruthy();
    expect(validateChangelistName('-x')).toBeTruthy();
    expect(validateChangelistName('a\nb')).toBeTruthy();
    expect(validateChangelistName('Changes')).toBeTruthy();
    expect(validateChangelistName('feature x')).toBeUndefined();
  });
});

describe('status xml: changelists and locks', () => {
  const xml = `<status><target path="."><entry path="p2.txt"><wc-status item="added" props="none"/></entry>
  <entry path="k.txt"><wc-status item="normal" props="none" revision="3"><lock><token>t1</token><owner>me</owner><comment>a
b</comment><created>2026-01-01T00:00:00Z</created></lock></wc-status><repos-status item="none" props="none"><lock><token>t1</token><owner>me</owner></lock></repos-status></entry></target>
  <changelist name="cl1"><entry path="p1.txt"><wc-status item="added" props="none"/></entry></changelist></status>`;
  it('reads changelist members and lock info', () => {
    const { entries } = parseStatus(xml);
    expect(entries.find((x) => x.path === 'p1.txt')?.changelist).toBe('cl1');
    expect(entries.find((x) => x.path === 'p2.txt')?.changelist).toBeUndefined();
    const k = entries.find((x) => x.path === 'k.txt');
    expect(k?.lock).toMatchObject({ token: 't1', owner: 'me', comment: 'a\nb' });
    expect(k?.repoLock?.owner).toBe('me');
  });
});

describe('commit selection model', () => {
  const entries = [
    e('a.txt', 'modified'),
    e('b.txt', 'unversioned'),
    e('dir', 'added', { isDir: true }),
    e('dir\\c.txt', 'added'),
    e('d.txt', 'conflicted'),
    e('f.txt', 'normal', { props: 'modified' }),
    e('g.txt', 'missing'),
  ];
  it('classifies rows', () => {
    expect(entryKind(entries[0])).toBe('commit');
    expect(entryKind(entries[1])).toBe('unversioned');
    expect(entryKind(entries[4])).toBe('blocked');
    expect(entryKind(entries[5])).toBe('commit');
    expect(entryKind(entries[6])).toBe('blocked');
  });
  it('pre-checks committable items only; unversioned only when pointed at exactly', () => {
    const all = defaultChecked(entries);
    expect([...all].map((p) => p.split('\\').pop()).sort()).toEqual(['a.txt', 'c.txt', 'dir', 'f.txt']);
    expect(defaultChecked(entries, ['C:\\wc\\a.txt']).size).toBe(1);
    expect(defaultChecked(entries, ['C:\\wc\\b.txt']).has('C:\\wc\\b.txt')).toBe(true);
    expect(defaultChecked(entries, ['C:\\wc\\dir']).size).toBe(2);
  });
  it('builds add/commit lists and pulls in added parent folders', () => {
    const plan = buildPlan('r', entries, ['C:\\wc\\dir\\c.txt', 'C:\\wc\\b.txt', 'C:\\wc\\d.txt']);
    expect(plan.add).toEqual(['C:\\wc\\b.txt']);
    expect(plan.commit).toContain('C:\\wc\\dir');
    expect(plan.implied).toEqual(['C:\\wc\\dir']);
    expect(plan.rejected).toEqual(['C:\\wc\\d.txt']);
  });
  it('ignores other repos and unselected rows', () => {
    const plan = buildPlan('other', entries, ['C:\\wc\\a.txt']);
    expect(plan.commit).toEqual([]);
  });
  it('allows an empty message; validates selection', () => {
    const ok = buildPlan('r', entries, ['C:\\wc\\a.txt']);
    expect(validateCommit('  ', [ok])).toBeUndefined();
    expect(validateCommit('', [ok])).toBeUndefined();
    expect(validateCommit('x', [buildPlan('r', entries, [])])).toMatch(/Select/);
    expect(validateCommit('x', [buildPlan('r', entries, ['C:\\wc\\d.txt', 'C:\\wc\\a.txt'])])).toMatch(/Cannot commit/);
    expect(validateCommit('x', [ok])).toBeUndefined();
  });
  it('detects out-of-date rejections', () => {
    expect(isOutOfDate("svn: E155011: Commit failed (details follow):\nsvn: E160024: File '/a' is out of date")).toBe(true);
    expect(isOutOfDate('svn: E170013: Unable to connect')).toBe(false);
  });
});

describe('message history', () => {
  it('keeps newest first, dedupes, trims and caps', () => {
    let h: string[] = [];
    h = pushHistory(h, ' one ', 3);
    h = pushHistory(h, 'two', 3);
    h = pushHistory(h, 'one', 3);
    expect(h).toEqual(['one', 'two']);
    h = pushHistory(h, 'three', 3);
    h = pushHistory(h, 'four', 3);
    expect(h).toEqual(['four', 'three', 'one']);
    expect(pushHistory(h, '   ', 3)).toEqual(h);
    expect(pushHistory(h, 'x', 0)).toEqual([]);
  });
  it('sanitizes stored data', () => {
    expect(sanitizeHistory([1, 'a', '', ' ', 'b'], 5)).toEqual(['a', 'b']);
    expect(sanitizeHistory('nope', 5)).toEqual([]);
    expect(sanitizeHistory(['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
  });
});

describe('webview page', () => {
  it('uses a strict CSP: no unsafe-inline, nonce scripts only', () => {
    const csp = contentSecurityPolicy('vscode-resource:', 'abc');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-abc'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    const html = webviewHtml({ cspSource: 'vscode-resource:', nonce: 'abc', title: 'T<x>', scriptUri: 'a.js', styleUri: 'a.css', body: '<p>x</p>' });
    expect(html).toContain('nonce="abc" src="a.js"');
    expect(html).toContain('T&#60;x&#62;');
    expect(html).not.toMatch(/<script(?![^>]*nonce)/);
  });
});

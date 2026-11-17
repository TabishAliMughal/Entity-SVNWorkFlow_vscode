import { describe, expect, it } from 'vitest';
import { dedupeNested, groupPathsByRepo, parseCommittedRevision, parseUpdateConflicts, parseUpdatedRevision, summarizePaths } from '../../src/ops/targets';
import { countItems, statusBarText, statusBarTooltip } from '../../src/status/format';

describe('target aggregation', () => {
  it('drops nested and duplicate paths', () => {
    expect(dedupeNested(['/wc/a', '/wc/a/b.txt', '/wc/a', '/wc/c.txt']).length).toBe(2);
    expect(dedupeNested(['/wc/a/b.txt', '/wc/a'])).toEqual(['/wc/a']);
  });
  it('does not treat a name prefix as nesting', () => {
    expect(dedupeNested(['/wc/a', '/wc/ab']).length).toBe(2);
  });
  it('groups by repo', () => {
    const r1 = { name: 'r1' };
    const r2 = { name: 'r2' };
    const g = groupPathsByRepo([
      { repo: r1, fsPath: '/w1/d' },
      { repo: r1, fsPath: '/w1/d/f' },
      { repo: r2, fsPath: '/w2/x' },
    ]);
    expect(g.get('r1')?.paths).toEqual(['/w1/d']);
    expect(g.get('r2')?.paths).toEqual(['/w2/x']);
  });
});

describe('svn output parsing', () => {
  it('parses revisions and conflicts', () => {
    expect(parseCommittedRevision('Sending a\nCommitted revision 12.\n')).toBe(12);
    expect(parseCommittedRevision('nothing')).toBeUndefined();
    expect(parseUpdatedRevision('Updating ...\nUpdated to revision 7.\n')).toBe(7);
    expect(parseUpdatedRevision('At revision 7.')).toBe(7);
    const out = "Updating '.':\nU    a.txt\nC    b.txt\n UC   c.txt\nConflict discovered in file\nUpdated to revision 9.\nSummary of conflicts:\n  Text conflicts: 1\n";
    expect(parseUpdateConflicts(out)).toEqual(['b.txt', 'c.txt']);
  });
  it('summarizes long lists', () => {
    expect(summarizePaths(['a', 'b', 'c'], (p) => p, 2)).toBe('  a\n  b\n  ... and 1 more');
  });
});

describe('status bar text', () => {
  it('shows counts, repo name and state icons', () => {
    const base = { busy: false, incoming: 2, outgoing: 3, failing: 0 };
    expect(statusBarText({ ...base, repoName: 'alpha' })).toBe('$(source-control) alpha $(arrow-down)2 $(arrow-up)3');
    expect(statusBarText(base)).toContain('SVN');
    expect(statusBarText({ ...base, busy: true })).toContain('sync~spin');
    expect(statusBarText({ ...base, failing: 1 })).toContain('$(warning)');
    expect(statusBarTooltip({ ...base, failing: 1 }, 'Updating')).toContain('Running: Updating');
  });
  it('counts items', () => {
    expect(countItems([{ incoming: true, outgoing: false }, { incoming: true, outgoing: true }])).toEqual({ incoming: 2, outgoing: 1 });
  });
});

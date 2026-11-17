import { describe, expect, it } from 'vitest';
import { buildResult, conflictText, merge3, segmentSources, splitConflictMarkers, type Choice } from '../../src/conflict/merge';

const L = (...l: string[]): string => l.map((x) => x + '\n').join('');
const result = (b: string, m: string, t: string, choices: Array<Choice | undefined> = [], opts = {}) => buildResult(merge3(b, m, t, opts), choices);

describe('merge3', () => {
  it('merges non-overlapping changes from both sides', () => {
    const base = L('a', 'b', 'c', 'd', 'e', 'f');
    const mine = L('a', 'B', 'c', 'd', 'e', 'f');
    const theirs = L('a', 'b', 'c', 'd', 'E', 'f');
    const m = merge3(base, mine, theirs);
    expect(m.conflicts).toHaveLength(0);
    expect(result(base, mine, theirs).text).toBe(L('a', 'B', 'c', 'd', 'E', 'f'));
    expect(m.segments.filter((s) => s.kind === 'auto').map((s) => (s.kind === 'auto' ? s.from : ''))).toEqual(['mine', 'theirs']);
  });

  it('takes the only changed side', () => {
    const base = L('a', 'b');
    expect(result(base, base, L('a', 'x', 'b')).text).toBe(L('a', 'x', 'b'));
    expect(result(base, L('z', 'a', 'b'), base).text).toBe(L('z', 'a', 'b'));
    expect(merge3(base, base, base).segments).toHaveLength(1);
  });

  it('reports overlapping changes as one conflict block', () => {
    const base = L('a', 'b', 'c');
    const m = merge3(base, L('a', 'M', 'c'), L('a', 'T', 'c'));
    expect(m.conflicts).toHaveLength(1);
    const c = m.conflicts[0];
    expect(conflictText(m, c, 'mine')).toBe(L('M'));
    expect(conflictText(m, c, 'theirs')).toBe(L('T'));
    expect(conflictText(m, c, 'base')).toBe(L('b'));
  });

  it('applies each choice', () => {
    const base = L('a', 'b', 'c');
    const mine = L('a', 'M', 'c');
    const theirs = L('a', 'T', 'c');
    expect(result(base, mine, theirs, ['mine']).text).toBe(mine);
    expect(result(base, mine, theirs, ['theirs']).text).toBe(theirs);
    expect(result(base, mine, theirs, ['base']).text).toBe(base);
    expect(result(base, mine, theirs, ['mine-theirs']).text).toBe(L('a', 'M', 'T', 'c'));
    expect(result(base, mine, theirs, ['theirs-mine']).text).toBe(L('a', 'T', 'M', 'c'));
    const m = merge3(base, mine, theirs);
    expect(buildResult(m, ['custom'], new Map([[0, L('hand', 'made')]])).text).toBe(L('a', 'hand', 'made', 'c'));
  });

  it('writes conflict markers for an unresolved block and counts it', () => {
    const r = result(L('a', 'b'), L('a', 'M'), L('a', 'T'));
    expect(r.unresolved).toBe(1);
    expect(r.text).toBe(L('a', '<<<<<<< mine', 'M', '||||||| base', 'b', '=======', 'T', '>>>>>>> theirs'));
  });

  it('treats identical changes on both sides as auto-merged, not a conflict', () => {
    const base = L('a', 'b', 'c');
    const both = L('a', 'X', 'c');
    const m = merge3(base, both, both);
    expect(m.conflicts).toHaveLength(0);
    expect(m.segments.some((s) => s.kind === 'auto' && s.from === 'both')).toBe(true);
    expect(result(base, both, both).text).toBe(both);
    // same insertion at the same point
    const m2 = merge3(L('a', 'b'), L('a', 'n', 'b'), L('a', 'n', 'b'));
    expect(m2.conflicts).toHaveLength(0);
  });

  it('narrows a conflict by splitting off lines both sides share', () => {
    const base = L('a', 'b', 'c');
    // both replace b with X first, then mine adds M, theirs adds T
    const m = merge3(base, L('a', 'X', 'M', 'c'), L('a', 'X', 'T', 'c'));
    expect(m.conflicts).toHaveLength(1);
    expect(conflictText(m, m.conflicts[0], 'mine')).toBe(L('M'));
    expect(conflictText(m, m.conflicts[0], 'theirs')).toBe(L('T'));
    expect(result(L('a', 'b', 'c'), L('a', 'X', 'M', 'c'), L('a', 'X', 'T', 'c'), ['theirs']).text).toBe(L('a', 'X', 'T', 'c'));
  });

  it('treats two different insertions at the same point as a conflict', () => {
    const m = merge3(L('a', 'b'), L('a', 'M', 'b'), L('a', 'T', 'b'));
    expect(m.conflicts).toHaveLength(1);
    expect(result(L('a', 'b'), L('a', 'M', 'b'), L('a', 'T', 'b'), ['mine-theirs']).text).toBe(L('a', 'M', 'T', 'b'));
  });

  it('treats touching changes as a conflict (like diff3) and merges changes with a line between', () => {
    // adjacent lines changed on each side
    const adj = merge3(L('a', 'b', 'c', 'd'), L('a', 'B', 'c', 'd'), L('a', 'b', 'C', 'd'));
    expect(adj.conflicts).toHaveLength(1);
    // one unchanged line between: merges
    const gap = merge3(L('a', 'b', 'c', 'd', 'e'), L('a', 'B', 'c', 'd', 'e'), L('a', 'b', 'c', 'D', 'e'));
    expect(gap.conflicts).toHaveLength(0);
    expect(buildResult(gap, []).text).toBe(L('a', 'B', 'c', 'D', 'e'));
  });

  it('handles delete versus modify and delete on both sides', () => {
    const base = L('a', 'b', 'c');
    const dm = merge3(base, L('a', 'c'), L('a', 'T', 'c'));
    expect(dm.conflicts).toHaveLength(1);
    expect(conflictText(dm, dm.conflicts[0], 'mine')).toBe('');
    const dd = merge3(base, L('a', 'c'), L('a', 'c'));
    expect(dd.conflicts).toHaveLength(0);
    expect(buildResult(dd, []).text).toBe(L('a', 'c'));
  });

  it('keeps line offsets right across several clusters (multiple conflicts and auto merges)', () => {
    const base = L('1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11');
    const mine = L('m1', '2', '3', 'm4a', 'm4b', '5', '6', '7', '8', '9', 'm10', '11', 'm12');
    const theirs = L('1', '2', '3', 't4', '5', '6', '7', 't8', '9', '10', '11');
    const m = merge3(base, mine, theirs);
    expect(m.conflicts).toHaveLength(1);
    expect(m.segments.filter((s) => s.kind === 'auto')).toHaveLength(4);
    expect(buildResult(m, ['theirs']).text).toBe(L('m1', '2', '3', 't4', '5', '6', '7', 't8', '9', 'm10', '11', 'm12'));
  });

  it('handles empty inputs', () => {
    expect(merge3('', '', '').segments).toHaveLength(0);
    const m = merge3('', L('a'), L('b'));
    expect(m.conflicts).toHaveLength(1);
    expect(buildResult(m, ['theirs']).text).toBe(L('b'));
    expect(buildResult(merge3('', L('a'), ''), []).text).toBe(L('a'));
  });

  describe('options', () => {
    it('ignore whitespace: a whitespace-only edit on one side does not collide with a real edit on the other', () => {
      const base = L('a', 'b', 'c');
      const mine = L('a', '  b  ', 'c');
      const theirs = L('a', 'T', 'c');
      expect(merge3(base, mine, theirs).conflicts).toHaveLength(1);
      const m = merge3(base, mine, theirs, { ignoreWhitespace: 'all' });
      expect(m.conflicts).toHaveLength(0);
      expect(buildResult(m, []).text).toBe(L('a', 'T', 'c'));
    });

    it('ignore whitespace: identical-apart-from-whitespace edits merge without conflict', () => {
      const m = merge3(L('a', 'b'), L('a', 'x  y'), L('a', 'x y'), { ignoreWhitespace: 'all' });
      expect(m.conflicts).toHaveLength(0);
      expect(merge3(L('a', 'b'), L('a', 'x  y'), L('a', 'x y')).conflicts).toHaveLength(1);
    });

    it('ignore case', () => {
      expect(merge3(L('a', 'b'), L('a', 'HELLO'), L('a', 'hello')).conflicts).toHaveLength(1);
      expect(merge3(L('a', 'b'), L('a', 'HELLO'), L('a', 'hello'), { ignoreCase: true }).conflicts).toHaveLength(0);
    });

    it('ignore EOL: CRLF mine and LF theirs with the same edit; result keeps the working file ending', () => {
      const base = 'a\nb\nc\n';
      const mine = 'a\r\nX\r\nc\r\n';
      const theirs = 'a\nX\nc\n';
      expect(merge3(base, mine, theirs).conflicts).toHaveLength(1);
      const m = merge3(base, mine, theirs, { ignoreEol: true });
      expect(m.conflicts).toHaveLength(0);
      expect(buildResult(m, []).text).toBe(mine);
    });

    it('normalises endings of lines taken from theirs to the working file ending', () => {
      const base = 'a\r\nb\r\nc\r\nd\r\ne\r\n';
      const mine = 'a\r\nB\r\nc\r\nd\r\ne\r\n';
      const theirs = 'a\nb\nc\nd\nE\n';
      const m = merge3(base, mine, theirs, { ignoreEol: true });
      expect(buildResult(m, []).text).toBe('a\r\nB\r\nc\r\nd\r\nE\r\n');
    });

    it('keeps a missing final newline', () => {
      expect(result('a\nb', 'a\nb', 'a\nB').text).toBe('a\nB');
      expect(result('a\nb\nc', 'a\nB\nc', 'a\nb\nc').text).toBe('a\nB\nc');
    });
  });

  it('segments cover every line of mine and theirs exactly once', () => {
    const base = L('1', '2', '3', '4', '5', '6');
    const mine = L('1', 'a', '3', '4', 'x', 'y', '6', '7');
    const theirs = L('0', '1', 'b', '3', '4', '5', 'z');
    const m = merge3(base, mine, theirs);
    let mi = 0;
    let ti = 0;
    for (const s of m.segments) {
      expect(s.mine.start).toBe(mi);
      expect(s.theirs.start).toBe(ti);
      mi = s.mine.end;
      ti = s.theirs.end;
    }
    expect(mi).toBe(m.mine.length);
    expect(ti).toBe(m.theirs.length);
  });

  it('segmentSources reports no lines for an unresolved conflict', () => {
    const m = merge3(L('a'), L('b'), L('c'));
    expect(segmentSources(m.conflicts[0])).toEqual([]);
    expect(segmentSources(m.conflicts[0], 'theirs')).toEqual([{ side: 'theirs', range: m.conflicts[0].theirs }]);
  });
});

describe('splitConflictMarkers', () => {
  it('rebuilds the three sides from svn diff3 markers', () => {
    const text = L('a', '<<<<<<< .mine', 'B1', '||||||| .r280', 'b', '=======', 'B2', '>>>>>>> .r282', 'c');
    expect(splitConflictMarkers(text)).toEqual({ base: L('a', 'b', 'c'), mine: L('a', 'B1', 'c'), theirs: L('a', 'B2', 'c') });
  });
  it('returns undefined without a complete marker block', () => {
    expect(splitConflictMarkers(L('a', 'b'))).toBeUndefined();
    expect(splitConflictMarkers(L('<<<<<<< x', 'a'))).toBeUndefined();
  });
});

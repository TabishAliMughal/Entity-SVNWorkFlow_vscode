import { describe, expect, it } from 'vitest';
import { diffLines } from '../../src/diff';
import { buildRows, hunkSpans } from '../../src/compare/rows';

const rowsOf = (a: string, b: string) => buildRows(diffLines(a, b).blocks);

describe('hunk spans', () => {
  it('spans the whole changed section', () => {
    const spans = hunkSpans(rowsOf('a\nb\nc\nd\ne\n', 'a\nX\nY\nZ\nW\ne\n'));
    expect(spans).toHaveLength(1);
    const sp = spans[0];
    expect(sp.first).toBe(1);
    expect(sp.count).toBe(4);
  });
  it('sits on the gap of a pure insert and on the lines of a pure delete', () => {
    const ins = hunkSpans(rowsOf('a\nb\n', 'a\nX\nY\nb\n'))[0];
    expect(ins).toMatchObject({ first: 1, count: 2, leftCount: 0, rightCount: 2 });
    const del = hunkSpans(rowsOf('a\nX\nb\n', 'a\nb\n'))[0];
    expect(del).toMatchObject({ first: 1, count: 1, leftCount: 1, rightCount: 0 });
  });
  it('reports one span per hunk', () => {
    expect(hunkSpans(rowsOf('a\nb\nc\nd\ne\n', 'x\nb\nc\nd\ny\n')).map((s) => s.hunk)).toEqual([0, 1]);
  });
});

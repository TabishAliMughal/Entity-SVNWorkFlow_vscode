import { describe, expect, it } from 'vitest';
import { diffLines } from '../../src/diff';
import { arrowTop, buildRows, hunkSpans, shiftRows } from '../../src/compare/rows';
import {
  applyEditToLines, colAtVisual, endPosition, reindent, textInRange, visualCol, wordAt, wordLeft, wordRight,
} from '../../src/compare/editing';
import { EditHistory } from '../../src/compare/history';

const rowsOf = (a: string, b: string) => buildRows(diffLines(a, b).blocks);

describe('hunk arrows', () => {
  it('centres the arrow on the whole changed section', () => {
    const spans = hunkSpans(rowsOf('a\nb\nc\nd\ne\n', 'a\nX\nY\nZ\nW\ne\n'));
    expect(spans).toHaveLength(1);
    const sp = spans[0];
    expect(sp.first).toBe(1);
    expect(sp.count).toBe(4);
    expect(arrowTop(sp, 20, 18)).toBe((1 + 2) * 20 - 9);
  });
  it('sits on the gap of a pure insert and on the lines of a pure delete', () => {
    const ins = hunkSpans(rowsOf('a\nb\n', 'a\nX\nY\nb\n'))[0];
    expect(ins).toMatchObject({ first: 1, count: 2, leftCount: 0, rightCount: 2 });
    const del = hunkSpans(rowsOf('a\nX\nb\n', 'a\nb\n'))[0];
    expect(del).toMatchObject({ first: 1, count: 1, leftCount: 1, rightCount: 0 });
    expect(arrowTop(del, 20, 18)).toBe(20 + 10 - 9);
  });
  it('reports one span per hunk', () => {
    expect(hunkSpans(rowsOf('a\nb\nc\nd\ne\n', 'x\nb\nc\nd\ny\n')).map((s) => s.hunk)).toEqual([0, 1]);
  });
});

describe('shiftRows', () => {
  const base = rowsOf('a\nb\nc\n', 'a\nB\nc\n');
  it('shifts later lines when a line is split', () => {
    const r = shiftRows(base, 'left', 0, 0, 2);
    expect(r.map((x) => x.left)).toEqual([0, 1, 2, 3]);
    expect(r[1].right).toBe(-1);
    expect(r[2].right).toBe(1);
  });
  it('turns surplus lines into fillers when lines are joined', () => {
    const r = shiftRows(base, 'left', 0, 1, 1);
    expect(r.map((x) => x.left)).toEqual([0, -1, 1]);
    expect(r[1].right).toBe(1);
  });
  it('drops rows left empty on both sides', () => {
    const rows = rowsOf('a\nb\n', 'a\n');
    expect(shiftRows(rows, 'left', 0, 1, 1).map((x) => x.left)).toEqual([0]);
  });
});

describe('editing helpers', () => {
  it('applies single and multi-line edits in place', () => {
    const l = ['hello world', 'second'];
    applyEditToLines(l, { line: 0, col: 5 }, { line: 0, col: 5 }, '\n  ');
    expect(l).toEqual(['hello', '   world', 'second']);
    applyEditToLines(l, { line: 0, col: 3 }, { line: 2, col: 3 }, 'X');
    expect(l).toEqual(['helXond']);
    applyEditToLines(l, { line: 0, col: 7 }, { line: 0, col: 7 }, '\n');
    expect(l).toEqual(['helXond', '']);
  });
  it('handles huge pastes', () => {
    const l = ['a', 'b'];
    applyEditToLines(l, { line: 0, col: 1 }, { line: 0, col: 1 }, Array.from({ length: 5000 }, (_, i) => i).join('\n'));
    expect(l).toHaveLength(5001);
    expect(l[l.length - 1]).toBe('b');
    expect(l[l.length - 2]).toBe('4999');
  });
  it('computes end positions and range text', () => {
    expect(endPosition({ line: 2, col: 4 }, 'ab')).toEqual({ line: 2, col: 6 });
    expect(endPosition({ line: 2, col: 4 }, 'ab\ncd\nef')).toEqual({ line: 4, col: 2 });
    expect(endPosition({ line: 0, col: 0 }, '\n')).toEqual({ line: 1, col: 0 });
    expect(textInRange(['abc', 'def', 'ghi'], { line: 0, col: 1 }, { line: 2, col: 2 })).toBe('bc\ndef\ngh');
  });
  it('maps columns through tabs', () => {
    expect(visualCol('\tab', 1)).toBe(4);
    expect(visualCol('a\tb', 2)).toBe(4);
    expect(colAtVisual('a\tb', 3.9)).toBe(2);
    expect(colAtVisual('abc', 1.4)).toBe(1);
    expect(colAtVisual('abc', 1.6)).toBe(2);
    expect(colAtVisual('abc', 99)).toBe(3);
  });
  it('moves by words', () => {
    expect(wordLeft('foo bar  baz', 12)).toBe(9);
    expect(wordLeft('foo bar', 3)).toBe(0);
    expect(wordRight('foo bar', 0)).toBe(4);
    expect(wordRight('foo.bar', 0)).toBe(3);
    expect(wordAt('foo bar', 5)).toEqual([4, 7]);
  });
  it('indents and outdents whole lines', () => {
    expect(reindent(['a', '', 'b'], 0, 2, false, '  ')).toBe('  a\n\n  b');
    expect(reindent(['    a', '\tb', 'c'], 0, 2, true, '  ')).toBe('a\nb\nc');
  });
});

describe('EditHistory', () => {
  it('undoes and redoes with the caret after the change', () => {
    const h = new EditHistory();
    h.record({ start: { line: 1, col: 2 }, removed: 'xy', inserted: 'A\nB', time: 0 });
    const u = h.undo();
    expect(u).toEqual({ start: { line: 1, col: 2 }, end: { line: 2, col: 1 }, text: 'xy', caret: { line: 1, col: 4 } });
    expect(h.undo()).toBeUndefined();
    const r = h.redo();
    expect(r).toEqual({ start: { line: 1, col: 2 }, end: { line: 1, col: 4 }, text: 'A\nB', caret: { line: 2, col: 1 } });
  });
  it('groups consecutive typing, but not after a pause or a jump', () => {
    const h = new EditHistory(100, 1000);
    h.record({ start: { line: 0, col: 0 }, removed: '', inserted: 'a', time: 0 });
    h.record({ start: { line: 0, col: 1 }, removed: '', inserted: 'b', time: 100 });
    h.record({ start: { line: 0, col: 2 }, removed: '', inserted: 'c', time: 5000 });
    h.record({ start: { line: 5, col: 0 }, removed: '', inserted: 'd', time: 5100 });
    expect(h.undo()?.end).toEqual({ line: 5, col: 1 });
    expect(h.undo()?.end).toEqual({ line: 0, col: 3 });
    expect(h.undo()?.end).toEqual({ line: 0, col: 2 });
    expect(h.undo()).toBeUndefined();
  });
  it('drops the redo stack on a new edit', () => {
    const h = new EditHistory();
    h.record({ start: { line: 0, col: 0 }, removed: '', inserted: 'a\n', time: 0 });
    h.undo();
    h.record({ start: { line: 0, col: 0 }, removed: '', inserted: 'z\n', time: 10 });
    expect(h.redo()).toBeUndefined();
  });
});

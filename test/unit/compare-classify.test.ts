import { describe, expect, it } from 'vitest';
import { diffLines } from '../../src/diff';
import { classifyHunks, rangesOverlap } from '../../src/compare/classify';
import { hunkAtY, rowAtY, rulerMarkers, viewportThumb } from '../../src/compare/ruler';

const L = (...l: string[]): string => l.join('\n') + '\n';
const classes = (base: string, local: string, incoming: string): string[] => classifyHunks(base, local, incoming, diffLines(local, incoming).hunks);

const BASE = L('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h');

describe('rangesOverlap', () => {
  it('treats touching ranges as not overlapping', () => {
    expect(rangesOverlap(0, 2, 2, 4)).toBe(false);
    expect(rangesOverlap(0, 3, 2, 4)).toBe(true);
  });
  it('handles empty insertion points', () => {
    expect(rangesOverlap(2, 2, 2, 2)).toBe(true);
    expect(rangesOverlap(2, 2, 0, 2)).toBe(false);
    expect(rangesOverlap(2, 2, 1, 3)).toBe(true);
  });
});

describe('classifyHunks (BASE as common ancestor)', () => {
  it('server-only change is incoming', () => {
    expect(classes(BASE, BASE, L('a', 'B', 'c', 'd', 'e', 'f', 'g', 'h'))).toEqual(['incoming']);
  });
  it('local-only change is outgoing', () => {
    expect(classes(BASE, L('a', 'b', 'c', 'D', 'e', 'f', 'g', 'h'), BASE)).toEqual(['outgoing']);
  });
  it('both changing the same line differently is a conflict', () => {
    expect(classes(BASE, L('a', 'X', 'c', 'd', 'e', 'f', 'g', 'h'), L('a', 'Y', 'c', 'd', 'e', 'f', 'g', 'h'))).toEqual(['conflict']);
  });
  it('separate regions are classified separately', () => {
    const local = L('a', 'b', 'c', 'D', 'e', 'f', 'g', 'h');
    const incoming = L('a', 'B', 'c', 'd', 'e', 'f', 'g', 'H');
    expect(classes(BASE, local, incoming)).toEqual(['incoming', 'outgoing', 'incoming']);
  });
  it('the same change on both sides produces no hunk, so no conflict', () => {
    const both = L('a', 'Z', 'c', 'd', 'e', 'f', 'g', 'h');
    expect(classes(BASE, both, both)).toEqual([]);
    const local = L('a', 'Z', 'c', 'd', 'e', 'f', 'g', 'h');
    const incoming = L('a', 'Z', 'c', 'd', 'e', 'f', 'g', 'H');
    expect(classes(BASE, local, incoming)).toEqual(['incoming']);
  });
  it('adjacent but non-overlapping changes are not a conflict', () => {
    const local = L('a', 'X', 'c', 'd', 'e', 'f', 'g', 'h');
    const incoming = L('a', 'b', 'Y', 'd', 'e', 'f', 'g', 'h');
    const r = classes(BASE, local, incoming);
    expect(r).not.toContain('conflict');
    expect(r.length).toBeGreaterThan(0);
  });
  it('a delete on one side against an edit on the other is a conflict', () => {
    expect(classes(BASE, L('a', 'c', 'd', 'e', 'f', 'g', 'h'), L('a', 'B', 'c', 'd', 'e', 'f', 'g', 'h'))).toEqual(['conflict']);
  });
  it('a server delete of untouched lines is incoming; a local insertion is outgoing', () => {
    expect(classes(BASE, BASE, L('a', 'b', 'e', 'f', 'g', 'h'))).toEqual(['incoming']);
    expect(classes(BASE, L('a', 'b', 'NEW', 'c', 'd', 'e', 'f', 'g', 'h'), BASE)).toEqual(['outgoing']);
  });
  it('both inserting at the same place with different text is a conflict', () => {
    expect(classes(BASE, L('a', 'b', 'X', 'c', 'd', 'e', 'f', 'g', 'h'), L('a', 'b', 'Y', 'c', 'd', 'e', 'f', 'g', 'h'))).toEqual(['conflict']);
  });
});

describe('overview ruler mapping', () => {
  const spans = [{ hunk: 0, first: 10, count: 5 }, { hunk: 1, first: 90, count: 10 }];
  it('scales positions to the ruler height with a minimum marker size', () => {
    const m = rulerMarkers(spans, 100, 200);
    expect(m[0]).toEqual({ hunk: 0, top: 20, height: 10 });
    expect(m[1].top).toBe(180);
    expect(rulerMarkers([{ hunk: 0, first: 1, count: 1 }], 10000, 100)[0].height).toBe(3);
    expect(rulerMarkers([{ hunk: 0, first: 9999, count: 1 }], 10000, 100)[0].top).toBe(97);
    expect(rulerMarkers(spans, 0, 100)).toEqual([]);
  });
  it('maps y to a row and finds the nearest marker', () => {
    expect(rowAtY(100, 100, 200)).toBe(50);
    expect(rowAtY(-5, 100, 200)).toBe(0);
    expect(rowAtY(9999, 100, 200)).toBe(99);
    const m = rulerMarkers(spans, 100, 200);
    expect(hunkAtY(m, 25)).toBe(0);
    expect(hunkAtY(m, 33)).toBe(0);
    expect(hunkAtY(m, 100)).toBeUndefined();
    expect(hunkAtY(m, 178)).toBe(1);
  });
  it('shows the visible window as a thumb', () => {
    expect(viewportThumb(500, 250, 1000, 200)).toEqual({ top: 100, height: 50 });
    expect(viewportThumb(0, 100, 0, 200)).toEqual({ top: 0, height: 200 });
  });
});

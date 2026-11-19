import type { DiffBlock, Hunk } from '../diff';

/** One visual row of the side-by-side view. A missing index means a filler on that side. */
export interface Row {
  /** 0-based line index on each side, or -1 for a filler. */
  left: number;
  right: number;
  /** 'equal' or the hunk type. */
  kind: 'equal' | 'insert' | 'delete' | 'modify';
  /** Index into DiffResult.hunks, -1 for equal rows. */
  hunk: number;
  /** First row of its hunk (carries the pull arrow). */
  first: boolean;
}

/**
 * Aligns both sides row by row: equal runs pair line to line, an insert has fillers on the left,
 * a delete fillers on the right, a modify pairs lines top-down and pads the shorter side.
 */
export function buildRows(blocks: readonly DiffBlock[]): Row[] {
  const rows: Row[] = [];
  let hunkIndex = 0;
  for (const b of blocks) {
    if (b.type === 'equal') {
      const n = b.localEnd - b.localStart;
      for (let i = 0; i < n; i++) rows.push({ left: b.localStart + i, right: b.incomingStart + i, kind: 'equal', hunk: -1, first: false });
      continue;
    }
    const h = b as Hunk;
    const ln = h.localEnd - h.localStart;
    const rn = h.incomingEnd - h.incomingStart;
    const n = Math.max(ln, rn);
    for (let i = 0; i < n; i++) {
      rows.push({
        left: i < ln ? h.localStart + i : -1,
        right: i < rn ? h.incomingStart + i : -1,
        kind: h.type,
        hunk: hunkIndex,
        first: i === 0,
      });
    }
    hunkIndex++;
  }
  return rows;
}

/** Row index of the first row of each hunk (for next/prev navigation). */
export function hunkRowStarts(rows: readonly Row[]): number[] {
  const out: number[] = [];
  rows.forEach((r, i) => {
    if (r.first) out.push(i);
  });
  return out;
}

export interface HunkSpan {
  hunk: number;
  /** First row and number of rows of the hunk (both sides share them; the shorter side is padded with fillers). */
  first: number;
  count: number;
  /** Rows actually holding a line on each side (0 = pure insert/delete gap). */
  leftCount: number;
  rightCount: number;
}

export function hunkSpans(rows: readonly Row[]): HunkSpan[] {
  const out: HunkSpan[] = [];
  let cur: HunkSpan | undefined;
  rows.forEach((r, i) => {
    if (r.hunk < 0) {
      cur = undefined;
      return;
    }
    if (!cur || cur.hunk !== r.hunk) {
      cur = { hunk: r.hunk, first: i, count: 0, leftCount: 0, rightCount: 0 };
      out.push(cur);
    }
    cur.count++;
    if (r.left >= 0) cur.leftCount++;
    if (r.right >= 0) cur.rightCount++;
  });
  return out;
}

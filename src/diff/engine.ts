import { matchSequences } from './lcs';
import { lineKey, splitLines, type Line } from './text';
import type { DiffBlock, DiffOptions, DiffResult, EqualRun, Hunk, WordDiff } from './types';
import { lineSimilarity, wordDiff } from './words';

/** D13: min token similarity for a line to be treated as "the same line, edited". */
export const SIMILARITY_THRESHOLD = 0.6;
/** Modify hunks larger than this (lines, both sides together) skip eager word-level diff. */
export const WORD_DIFF_MAX_LINES = 400;

function split(h: Hunk, la: readonly Line[], lb: readonly Line[], ignoreCase: boolean): Hunk[] | null {
  const n = h.localEnd - h.localStart;
  const m = h.incomingEnd - h.incomingStart;
  if (n === m || n === 0 || m === 0) return null;
  const smallIsLocal = n < m;
  const s = Math.min(n, m);
  const l = Math.max(n, m);
  const small = smallIsLocal ? la.slice(h.localStart, h.localEnd) : lb.slice(h.incomingStart, h.incomingEnd);
  const large = smallIsLocal ? lb.slice(h.incomingStart, h.incomingEnd) : la.slice(h.localStart, h.localEnd);

  const lead: number[] = [];
  const trail: number[] = [];
  for (let i = 0; i < s; i++) {
    lead.push(lineSimilarity(small[i].text, large[i].text, ignoreCase));
    trail.push(lineSimilarity(small[i].text, large[l - s + i].text, ignoreCase));
  }
  let P = 0;
  while (P < s && lead[P] >= SIMILARITY_THRESHOLD) P++;
  let T = 0;
  while (T < s && trail[s - 1 - T] >= SIMILARITY_THRESHOLD) T++;

  let bestP = -1;
  let bestScore = -1;
  for (let p = Math.max(0, s - T); p <= Math.min(P, s); p++) {
    let score = 0;
    for (let i = 0; i < p; i++) score += lead[i];
    for (let i = p; i < s; i++) score += trail[i];
    if (score > bestScore) {
      bestScore = score;
      bestP = p;
    }
  }
  if (bestP < 0) return null;

  const p = bestP;
  const out: Hunk[] = [];
  const ls = h.localStart;
  const is = h.incomingStart;
  const mk = (type: Hunk['type'], l0: number, l1: number, i0: number, i1: number): Hunk => ({
    type,
    localStart: l0,
    localEnd: l1,
    incomingStart: i0,
    incomingEnd: i1,
  });
  // offsets into the large side: lead [0,p), middle [p, l-(s-p)), trail [l-(s-p), l)
  const tailStart = l - (s - p);
  const L = (a: number, b: number, small0: number, small1: number): Hunk =>
    smallIsLocal ? mk('modify', ls + small0, ls + small1, is + a, is + b) : mk('modify', ls + a, ls + b, is + small0, is + small1);
  if (p > 0) out.push(L(0, p, 0, p));
  out.push(
    smallIsLocal ? mk('insert', ls + p, ls + p, is + p, is + tailStart) : mk('delete', ls + p, ls + tailStart, is + p, is + p),
  );
  if (p < s) out.push(L(tailStart, l, p, s));
  return out;
}

function wordsFor(h: Hunk, la: readonly Line[], lb: readonly Line[], opts: DiffOptions): WordDiff {
  return wordDiff(
    la.slice(h.localStart, h.localEnd).map((x) => x.text),
    h.localStart,
    lb.slice(h.incomingStart, h.incomingEnd).map((x) => x.text),
    h.incomingStart,
    opts,
  );
}

export function diffParsed(la: readonly Line[], lb: readonly Line[], opts: DiffOptions = {}): DiffResult {
  const ids = new Map<string, number>();
  const toIds = (ls: readonly Line[]): Int32Array => {
    const arr = new Int32Array(ls.length);
    for (let i = 0; i < ls.length; i++) {
      const k = lineKey(ls[i], opts);
      let v = ids.get(k);
      if (v === undefined) {
        v = ids.size;
        ids.set(k, v);
      }
      arr[i] = v;
    }
    return arr;
  };
  const matches = matchSequences(toIds(la), toIds(lb));

  const blocks: DiffBlock[] = [];
  const gap = (a0: number, a1: number, b0: number, b1: number): void => {
    if (a0 === a1 && b0 === b1) return;
    const h: Hunk = {
      type: a0 === a1 ? 'insert' : b0 === b1 ? 'delete' : 'modify',
      localStart: a0,
      localEnd: a1,
      incomingStart: b0,
      incomingEnd: b1,
    };
    const parts = h.type === 'modify' ? split(h, la, lb, !!opts.ignoreCase) : null;
    blocks.push(...(parts ?? [h]));
  };
  let ai = 0;
  let bi = 0;
  for (const m of matches) {
    gap(ai, m.a, bi, m.b);
    const eq: EqualRun = { type: 'equal', localStart: m.a, localEnd: m.a + m.len, incomingStart: m.b, incomingEnd: m.b + m.len };
    blocks.push(eq);
    ai = m.a + m.len;
    bi = m.b + m.len;
  }
  gap(ai, la.length, bi, lb.length);

  const hunks = blocks.filter((b): b is Hunk => b.type !== 'equal');
  for (const h of hunks) {
    if (h.type === 'modify' && h.localEnd - h.localStart + h.incomingEnd - h.incomingStart <= WORD_DIFF_MAX_LINES) {
      h.words = wordsFor(h, la, lb, opts);
    }
  }
  return { blocks, hunks, localLineCount: la.length, incomingLineCount: lb.length, identical: hunks.length === 0 };
}

export function diffLines(local: string, incoming: string, opts: DiffOptions = {}): DiffResult {
  return diffParsed(splitLines(local), splitLines(incoming), opts);
}

/** Word-level diff for any hunk (use for modify hunks too large for the eager pass). */
export function wordDiffForHunk(local: string, incoming: string, hunk: Hunk, opts: DiffOptions = {}): WordDiff {
  return wordsFor(hunk, splitLines(local), splitLines(incoming), opts);
}

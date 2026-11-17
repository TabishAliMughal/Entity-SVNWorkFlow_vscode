import { matchSequences } from './lcs';
import type { DiffOptions, WordDiff, WordRange } from './types';

export interface Token {
  text: string;
  start: number;
  end: number;
}

const TOKEN_RE = /[\p{L}_$][\p{L}\p{N}_$]*|\p{N}+(?:\.\p{N}+)?|[ \t\f\v]+|[\s\S]/gu;

/** Identifiers, numbers, whitespace runs, single punctuation characters. */
export function tokenize(line: string): Token[] {
  const out: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(line)) !== null) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

const isWs = (t: string): boolean => /^\s+$/.test(t);

/** Dice coefficient over non-whitespace token multisets, 0..1. Blank lines score 0. */
export function lineSimilarity(a: string, b: string, ignoreCase = false): number {
  const fold = (s: string): string => (ignoreCase ? s.toLowerCase() : s);
  const ta = tokenize(a).filter((t) => !isWs(t.text));
  const tb = tokenize(b).filter((t) => !isWs(t.text));
  if (!ta.length || !tb.length) return 0;
  const counts = new Map<string, number>();
  for (const t of ta) counts.set(fold(t.text), (counts.get(fold(t.text)) ?? 0) + 1);
  let common = 0;
  for (const t of tb) {
    const c = counts.get(fold(t.text));
    if (c) {
      common++;
      counts.set(fold(t.text), c - 1);
    }
  }
  return (2 * common) / (ta.length + tb.length);
}

interface Flat {
  ids: number[];
  toks: { line: number; tok: Token | null }[];
}

function flatten(lines: readonly string[], firstLine: number, ids: Map<string, number>, ignoreWs: boolean, ignoreCase: boolean): Flat {
  const out: Flat = { ids: [], toks: [] };
  const idOf = (k: string): number => {
    let v = ids.get(k);
    if (v === undefined) {
      v = ids.size;
      ids.set(k, v);
    }
    return v;
  };
  lines.forEach((text, i) => {
    for (const tok of tokenize(text)) {
      out.ids.push(idOf(ignoreWs && isWs(tok.text) ? ' ' : 't' + (ignoreCase ? tok.text.toLowerCase() : tok.text)));
      out.toks.push({ line: firstLine + i, tok });
    }
    out.ids.push(idOf('\n'));
    out.toks.push({ line: firstLine + i, tok: null });
  });
  return out;
}

function changedRanges(flat: Flat, matchedMask: Uint8Array, skipWsOnly: boolean): WordRange[] {
  const ranges: WordRange[] = [];
  let cur: WordRange | null = null;
  let curWsOnly = true;
  const flush = (): void => {
    if (cur && !(skipWsOnly && curWsOnly)) ranges.push(cur);
    cur = null;
    curWsOnly = true;
  };
  flat.toks.forEach((t, i) => {
    if (!t.tok || matchedMask[i]) {
      flush();
      return;
    }
    if (cur && cur.line === t.line && cur.end === t.tok.start) cur.end = t.tok.end;
    else {
      flush();
      cur = { line: t.line, start: t.tok.start, end: t.tok.end };
    }
    if (!isWs(t.tok.text)) curWsOnly = false;
  });
  flush();
  return ranges;
}

/** Token-level diff of two blocks of lines (texts without EOL). Line numbers in the output are absolute. */
export function wordDiff(
  localLines: readonly string[],
  localFirst: number,
  incomingLines: readonly string[],
  incomingFirst: number,
  opts: DiffOptions = {},
): WordDiff {
  const ignoreWs = opts.ignoreWhitespace === 'all';
  const ids = new Map<string, number>();
  const fa = flatten(localLines, localFirst, ids, ignoreWs, !!opts.ignoreCase);
  const fb = flatten(incomingLines, incomingFirst, ids, ignoreWs, !!opts.ignoreCase);
  const ma = new Uint8Array(fa.ids.length);
  const mb = new Uint8Array(fb.ids.length);
  for (const m of matchSequences(fa.ids, fb.ids)) {
    for (let k = 0; k < m.len; k++) {
      ma[m.a + k] = 1;
      mb[m.b + k] = 1;
    }
  }
  return { local: changedRanges(fa, ma, ignoreWs), incoming: changedRanges(fb, mb, ignoreWs) };
}

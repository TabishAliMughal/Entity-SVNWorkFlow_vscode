import { diffLines, type DiffOptions, type Hunk } from '../diff';

/**
 * incoming: only the server changed the region; outgoing: only the local file did;
 * conflict: both changed overlapping BASE lines (differently, otherwise there would be no hunk);
 * mixed: both changed inside the hunk but on different BASE lines (neutral styling).
 */
export type HunkClass = 'incoming' | 'outgoing' | 'conflict' | 'mixed';

/** Line ranges [a0,a1) and [b0,b1) overlap; an empty range (a pure insertion point) overlaps another empty range at the same point or lies strictly inside a non-empty one. Touching ranges do not overlap. */
export function rangesOverlap(a0: number, a1: number, b0: number, b1: number): boolean {
  const aEmpty = a0 === a1;
  const bEmpty = b0 === b1;
  if (aEmpty && bEmpty) return a0 === b0;
  if (aEmpty) return b0 < a0 && a0 < b1;
  if (bEmpty) return a0 < b0 && b0 < a1;
  return a0 < b1 && b0 < a1;
}

/**
 * Classifies each hunk of local-vs-incoming with BASE as the common ancestor: diff BASE->local and BASE->incoming
 * (the exact LCS engine), then test which of those changes fall inside the hunk and whether they overlap in BASE lines.
 */
export function classifyHunks(base: string, local: string, incoming: string, hunks: readonly Hunk[], opts: DiffOptions = {}): HunkClass[] {
  // In diffLines(base, x) "local" coordinates are BASE lines and "incoming" coordinates are x lines.
  const lc = diffLines(base, local, opts).hunks;
  const ic = diffLines(base, incoming, opts).hunks;
  return hunks.map((h) => {
    const l = lc.filter((x) => rangesOverlap(x.incomingStart, x.incomingEnd, h.localStart, h.localEnd));
    const i = ic.filter((x) => rangesOverlap(x.incomingStart, x.incomingEnd, h.incomingStart, h.incomingEnd));
    if (l.length && i.length) return l.some((a) => i.some((b) => rangesOverlap(a.localStart, a.localEnd, b.localStart, b.localEnd))) ? 'conflict' : 'mixed';
    if (i.length) return 'incoming';
    if (l.length) return 'outgoing';
    return 'mixed';
  });
}

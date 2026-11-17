import { dominantEol, joinLines, splitLines, type Line } from './text';
import type { DiffOptions, Hunk } from './types';

function splice(
  target: Line[],
  tStart: number,
  tEnd: number,
  source: readonly Line[],
  sStart: number,
  sEnd: number,
  opts: DiffOptions,
): string {
  if (tStart < 0 || tEnd > target.length || tStart > tEnd || sStart < 0 || sEnd > source.length || sStart > sEnd) {
    throw new RangeError('hunk does not fit the given texts; recompute the diff');
  }
  const eol = dominantEol(target);
  const pulled = source.slice(sStart, sEnd).map((l) => ({
    text: l.text,
    // With EOL differences ignored the target's convention wins; otherwise the EOL is part of the change.
    eol: opts.ignoreEol && l.eol ? eol : l.eol,
  }));
  const lines = [...target.slice(0, tStart), ...pulled, ...target.slice(tEnd)];
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].eol === '') lines[i] = { text: lines[i].text, eol };
  }
  return joinLines(lines);
}

/** Pull one hunk from incoming into local; returns the new local text. */
export function applyHunk(local: string, incoming: string, hunk: Hunk, opts: DiffOptions = {}): string {
  return splice(splitLines(local), hunk.localStart, hunk.localEnd, splitLines(incoming), hunk.incomingStart, hunk.incomingEnd, opts);
}

/** Push one hunk from local into incoming; returns the new incoming text. */
export function applyHunkReverse(local: string, incoming: string, hunk: Hunk, opts: DiffOptions = {}): string {
  return splice(splitLines(incoming), hunk.incomingStart, hunk.incomingEnd, splitLines(local), hunk.localStart, hunk.localEnd, opts);
}

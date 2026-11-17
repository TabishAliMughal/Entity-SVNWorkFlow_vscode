import { diffParsed, joinLines, splitLines, type DiffOptions, type Line } from '../diff';
import { lineKey } from '../diff/text';
import { dominantEolOf } from '../compare/eol';

/** Half-open line range [start, end). */
export interface Range {
  start: number;
  end: number;
}

export type Side = 'base' | 'mine' | 'theirs';

interface SegmentBase {
  base: Range;
  mine: Range;
  theirs: Range;
}

/** Same in all three files (shown from mine). */
export interface StableSegment extends SegmentBase {
  kind: 'stable';
}

/** Changed on one side only, or identically on both: merged without asking. */
export interface AutoSegment extends SegmentBase {
  kind: 'auto';
  from: 'mine' | 'theirs' | 'both';
}

/** Both sides changed the same base lines differently. */
export interface ConflictSegment extends SegmentBase {
  kind: 'conflict';
  /** 0-based index among the conflicts. */
  index: number;
}

export type Segment = StableSegment | AutoSegment | ConflictSegment;

export interface Merge3 {
  base: Line[];
  mine: Line[];
  theirs: Line[];
  segments: Segment[];
  conflicts: ConflictSegment[];
}

interface H {
  s: number;
  e: number;
  os: number;
  oe: number;
  side: 0 | 1;
}

const hunksOf = (base: Line[], other: Line[], side: 0 | 1, opts: DiffOptions): H[] =>
  diffParsed(base, other, opts).hunks.map((h) => ({ s: h.localStart, e: h.localEnd, os: h.incomingStart, oe: h.incomingEnd, side }));

const growth = (hs: readonly H[]): number => hs.reduce((n, h) => n + (h.oe - h.os) - (h.e - h.s), 0);

/**
 * Three-way merge (diff3 style) on lines using the shared LCS engine. Changes that touch or overlap in the base
 * (including two insertions at the same point) form one cluster: changed by one side only, or identically by
 * both, it merges silently; anything else is a conflict. Common leading/trailing lines of a conflict's mine and
 * theirs sides are split off as auto-merged segments, so a conflict holds only the real difference.
 */
export function merge3Lines(base: Line[], mine: Line[], theirs: Line[], opts: DiffOptions = {}): Merge3 {
  const all = [...hunksOf(base, mine, 0, opts), ...hunksOf(base, theirs, 1, opts)].sort((a, b) => a.s - b.s || a.e - b.e);
  const segments: Segment[] = [];
  const conflicts: ConflictSegment[] = [];
  const key = (l: Line): string => lineKey(l, opts);
  let cursor = 0;
  let dM = 0;
  let dT = 0;

  const stable = (b0: number, b1: number): void => {
    if (b1 > b0) segments.push({ kind: 'stable', base: { start: b0, end: b1 }, mine: { start: b0 + dM, end: b1 + dM }, theirs: { start: b0 + dT, end: b1 + dT } });
  };

  let i = 0;
  while (i < all.length) {
    const members = [all[i]];
    const cs = all[i].s;
    let ce = all[i].e;
    i++;
    while (i < all.length && all[i].s <= ce) {
      ce = Math.max(ce, all[i].e);
      members.push(all[i]);
      i++;
    }
    stable(cursor, cs);
    const mm = members.filter((h) => h.side === 0);
    const tm = members.filter((h) => h.side === 1);
    const mineR: Range = { start: cs + dM, end: ce + dM + growth(mm) };
    const theirsR: Range = { start: cs + dT, end: ce + dT + growth(tm) };
    const baseR: Range = { start: cs, end: ce };
    dM += growth(mm);
    dT += growth(tm);
    cursor = ce;

    if (!tm.length) {
      segments.push({ kind: 'auto', from: 'mine', base: baseR, mine: mineR, theirs: theirsR });
      continue;
    }
    if (!mm.length) {
      segments.push({ kind: 'auto', from: 'theirs', base: baseR, mine: mineR, theirs: theirsR });
      continue;
    }
    const ml = mine.slice(mineR.start, mineR.end).map(key);
    const tl = theirs.slice(theirsR.start, theirsR.end).map(key);
    if (ml.length === tl.length && ml.every((k, n) => k === tl[n])) {
      segments.push({ kind: 'auto', from: 'both', base: baseR, mine: mineR, theirs: theirsR });
      continue;
    }
    let pre = 0;
    while (pre < ml.length && pre < tl.length && ml[pre] === tl[pre]) pre++;
    let suf = 0;
    while (suf < ml.length - pre && suf < tl.length - pre && ml[ml.length - 1 - suf] === tl[tl.length - 1 - suf]) suf++;
    if (pre) {
      segments.push({
        kind: 'auto',
        from: 'both',
        base: { start: baseR.start, end: baseR.start },
        mine: { start: mineR.start, end: mineR.start + pre },
        theirs: { start: theirsR.start, end: theirsR.start + pre },
      });
    }
    const c: ConflictSegment = {
      kind: 'conflict',
      index: conflicts.length,
      base: baseR,
      mine: { start: mineR.start + pre, end: mineR.end - suf },
      theirs: { start: theirsR.start + pre, end: theirsR.end - suf },
    };
    conflicts.push(c);
    segments.push(c);
    if (suf) {
      segments.push({
        kind: 'auto',
        from: 'both',
        base: { start: baseR.end, end: baseR.end },
        mine: { start: mineR.end - suf, end: mineR.end },
        theirs: { start: theirsR.end - suf, end: theirsR.end },
      });
    }
  }
  stable(cursor, base.length);
  return { base, mine, theirs, segments, conflicts };
}

export function merge3(base: string, mine: string, theirs: string, opts: DiffOptions = {}): Merge3 {
  return merge3Lines(splitLines(base), splitLines(mine), splitLines(theirs), opts);
}

export type Choice = 'mine' | 'theirs' | 'base' | 'mine-theirs' | 'theirs-mine' | 'custom';
export const CHOICES: readonly Choice[] = ['mine', 'theirs', 'base', 'mine-theirs', 'theirs-mine', 'custom'];

/** A run of lines of one input file; a segment's result is a list of these. */
export interface Source {
  side: Side;
  range: Range;
}

/** Where the result lines of a segment come from. Conflicts without a choice (or `custom`) yield no sources. */
export function segmentSources(seg: Segment, choice?: Choice): Source[] {
  const m: Source = { side: 'mine', range: seg.mine };
  const t: Source = { side: 'theirs', range: seg.theirs };
  const b: Source = { side: 'base', range: seg.base };
  if (seg.kind === 'stable') return [m];
  if (seg.kind === 'auto') return [seg.from === 'theirs' ? t : m];
  switch (choice) {
    case 'mine':
      return [m];
    case 'theirs':
      return [t];
    case 'base':
      return [b];
    case 'mine-theirs':
      return [m, t];
    case 'theirs-mine':
      return [t, m];
    default:
      return [];
  }
}

export type Choices = ReadonlyArray<Choice | undefined>;

export interface BuiltResult {
  text: string;
  /** Conflicts without a choice; they are written as conflict markers. */
  unresolved: number;
}

/** Normalises line endings to `eol`; an unterminated last line stays unterminated. */
export function normalizeEol(lines: Line[], eol: string): Line[] {
  return lines.map((l, i) => ({ text: l.text, eol: i === lines.length - 1 && l.eol === '' ? '' : eol }));
}

/**
 * Assembles the result file. `custom` maps a conflict index to hand-edited text. The result uses the dominant
 * line ending of mine (the working file), whatever the side a line came from.
 */
export function buildResult(m: Merge3, choices: Choices, custom: ReadonlyMap<number, string> = new Map()): BuiltResult {
  const src = { base: m.base, mine: m.mine, theirs: m.theirs };
  const eol = dominantEolOf(m.mine.length ? m.mine : m.theirs);
  const out: Line[] = [];
  let unresolved = 0;
  const take = (s: Source): void => {
    out.push(...src[s.side].slice(s.range.start, s.range.end));
  };
  for (const seg of m.segments) {
    if (seg.kind !== 'conflict') {
      segmentSources(seg).forEach(take);
      continue;
    }
    const choice = choices[seg.index];
    if (choice === 'custom') {
      out.push(...splitLines(custom.get(seg.index) ?? ''));
    } else if (!choice) {
      unresolved++;
      out.push({ text: '<<<<<<< mine', eol }, ...m.mine.slice(seg.mine.start, seg.mine.end));
      out.push({ text: '||||||| base', eol }, ...m.base.slice(seg.base.start, seg.base.end));
      out.push({ text: '=======', eol }, ...m.theirs.slice(seg.theirs.start, seg.theirs.end), { text: '>>>>>>> theirs', eol });
    } else {
      segmentSources(seg, choice).forEach(take);
    }
  }
  // A line without EOL that now sits in the middle needs one before the next line.
  const fixed = out.map((l, i) => (i < out.length - 1 && l.eol === '' ? { text: l.text, eol } : l));
  return { text: joinLines(normalizeEol(fixed, eol)), unresolved };
}

/** Text of a conflict block for a choice (what "Edit" starts from). */
export function conflictText(m: Merge3, seg: ConflictSegment, choice: Choice | undefined, custom: ReadonlyMap<number, string> = new Map()): string {
  if (choice === 'custom') return custom.get(seg.index) ?? '';
  const src = { base: m.base, mine: m.mine, theirs: m.theirs };
  return joinLines(segmentSources(seg, choice ?? 'mine').flatMap((s) => src[s.side].slice(s.range.start, s.range.end)));
}

/**
 * Recovers the three sides from a working file that holds svn's conflict markers (diff3 style, with the
 * `|||||||` base section). Used only when svn's `.mine` / `.rNNN` files are gone. Text outside the markers
 * counts for every side. Returns undefined when there is no complete marker block.
 */
export function splitConflictMarkers(text: string): { base: string; mine: string; theirs: string } | undefined {
  const lines = splitLines(text);
  const out = { base: [] as Line[], mine: [] as Line[], theirs: [] as Line[] };
  let state: 'out' | 'mine' | 'base' | 'theirs' = 'out';
  let blocks = 0;
  for (const l of lines) {
    const t = l.text;
    if (state === 'out' && /^<{7}( |$)/.test(t)) state = 'mine';
    else if (state === 'mine' && /^\|{7}( |$)/.test(t)) state = 'base';
    else if ((state === 'mine' || state === 'base') && /^={7}$/.test(t)) state = 'theirs';
    else if (state === 'theirs' && /^>{7}( |$)/.test(t)) {
      state = 'out';
      blocks++;
    } else if (state === 'out') {
      out.base.push(l);
      out.mine.push(l);
      out.theirs.push(l);
    } else if (state === 'mine') out.mine.push(l);
    else if (state === 'base') out.base.push(l);
    else out.theirs.push(l);
  }
  if (!blocks || state !== 'out') return undefined;
  return { base: joinLines(out.base), mine: joinLines(out.mine), theirs: joinLines(out.theirs) };
}

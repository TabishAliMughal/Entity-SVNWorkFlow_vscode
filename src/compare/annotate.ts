import type { BlameLine } from '../svn/xml';
import type { HunkClass } from './classify';

/** Last commit of a revision source (author, revision, date). */
export interface SideMeta {
  author?: string;
  revision?: number;
  date?: string;
}

export interface BlameEntry {
  author?: string;
  revision?: number;
  date?: string;
}

/** Compact blame for the wire: a table of distinct entries and, per line, an index into it (-1 = unknown). */
export interface CompactBlame {
  table: BlameEntry[];
  idx: number[];
}

/** Pane header text: "author · r4031", with the source label as prefix for BASE and as fallback when no author is known. */
export function sideTitle(label: string, meta: SideMeta | undefined, base = false): string {
  if (!meta || meta.revision === undefined) return label;
  const who = meta.author ? `${meta.author} · r${meta.revision}` : `r${meta.revision}`;
  return base ? `BASE · ${who}` : who;
}

export function compactBlame(lines: readonly BlameLine[], count: number): CompactBlame | undefined {
  const idx: number[] = new Array(count).fill(-1);
  const table: BlameEntry[] = [];
  const seen = new Map<string, number>();
  for (const b of lines) {
    const i = b.line - 1;
    if (i < 0 || i >= count) return undefined;
    const key = `${b.author ?? ''}\u0000${b.revision ?? ''}`;
    let t = seen.get(key);
    if (t === undefined) {
      t = table.length;
      table.push({ author: b.author, revision: b.revision, date: b.date });
      seen.set(key, t);
    }
    idx[i] = t;
  }
  return { table, idx };
}

export interface HunkAuthors {
  /** Authors in order of first appearance with the number of changed lines they own. */
  authors: { author: string; lines: number }[];
}

/** Who changed lines [start, end) of a side. Unknown authors are skipped. */
export function hunkAuthors(b: CompactBlame, start: number, end: number): HunkAuthors {
  const counts = new Map<string, number>();
  for (let i = start; i < end; i++) {
    const t = b.idx[i];
    const a = t >= 0 ? b.table[t].author : undefined;
    if (a) counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  return { authors: [...counts].map(([author, lines]) => ({ author, lines })) };
}

const p2 = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD HH:mm:ss` in local time; empty when the date is missing or invalid. */
export function formatLocalDate(iso?: string): string {
  const d = iso ? new Date(iso) : undefined;
  if (!d || isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** Newest commit (highest revision, else latest date) among the lines [start, end) that have an author. */
function newestEntry(b: CompactBlame, start: number, end: number): BlameEntry | undefined {
  let best: BlameEntry | undefined;
  for (let i = start; i < end; i++) {
    const t = b.idx[i];
    const e = t >= 0 ? b.table[t] : undefined;
    if (!e?.author) continue;
    const r = e.revision ?? -1;
    const br = best?.revision ?? -1;
    if (!best || r > br || (r === br && (e.date ?? '') > (best.date ?? ''))) best = e;
  }
  return best;
}

/** Monaco sizes the scroll width from the glyph run, so margin/padding would leave the end of the label clipped at maximum scroll; no-break spaces are counted. */
export const LABEL_TAIL = String.fromCharCode(0xa0).repeat(3);

/** Text of the injected label: the section label plus its scroll-width tail. */
export function renderedLabel(label: string): string {
  return label + LABEL_TAIL;
}

/** The label names who changed the incoming (right) side, so sections only the local side changed (outgoing) get none. No class (2-way compare) = shown. */
export function showsSectionLabel(cls?: HunkClass): boolean {
  return cls !== 'outgoing';
}

/** One label per changed section (lines [start, end) of the revision side): `<committer> | YYYY-MM-DD HH:mm:ss` of its newest commit. */
export function sectionLabel(b: CompactBlame, start: number, end: number): string | undefined {
  const e = newestEntry(b, start, end);
  if (!e?.author) return undefined;
  const when = formatLocalDate(e.date);
  return when ? `${e.author} | ${when}` : e.author;
}

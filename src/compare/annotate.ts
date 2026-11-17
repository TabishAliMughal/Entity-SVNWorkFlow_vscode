import type { BlameLine } from '../svn/xml';

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

/**
 * Label of a row inside a hunk: the hunk's first row shows its author (plus "+N" when more people touched it);
 * in a multi-author hunk every line whose author differs from the previous line shows its own.
 */
export function rowAuthorLabel(b: CompactBlame, start: number, end: number, line: number): { text: string; title: string } | undefined {
  if (line < start || line >= end) return undefined;
  const t = b.idx[line];
  const e = t >= 0 ? b.table[t] : undefined;
  const ha = hunkAuthors(b, start, end).authors;
  const entryTitle = e?.author ? `${e.author} · r${e.revision ?? '?'}${e.date ? ` · ${e.date.slice(0, 10)}` : ''}` : '';
  if (line === start) {
    if (!ha.length) return undefined;
    const text = ha.length > 1 ? `${e?.author ?? ha[0].author} +${ha.length - 1}` : ha[0].author;
    const title = ha.length > 1 ? ha.map((a) => `${a.author}: ${a.lines} line${a.lines === 1 ? '' : 's'}`).join('\n') : entryTitle || ha[0].author;
    return { text, title };
  }
  if (ha.length < 2 || !e?.author) return undefined;
  const pt = b.idx[line - 1];
  if (pt === t || (pt >= 0 && b.table[pt].author === e.author)) return undefined;
  return { text: e.author, title: entryTitle };
}

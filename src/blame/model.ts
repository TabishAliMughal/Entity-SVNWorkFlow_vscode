import { diffLines } from '../diff';
import type { BlameLine } from '../svn/xml';

/** Per displayed line: the BASE blame entry, or undefined for lines that are not (yet) committed. */
export type MappedBlame = (BlameLine | undefined)[];

/**
 * Aligns BASE blame with the current text. Lines inside an equal run keep their blame; lines in an
 * insert/modify hunk are uncommitted (undefined). `baseText` must be the text the blame was run on.
 */
export function mapBlameToText(blame: readonly BlameLine[], baseText: string, currentText: string): MappedBlame {
  const diff = diffLines(baseText, currentText, { ignoreEol: true });
  const out: MappedBlame = new Array(diff.incomingLineCount).fill(undefined);
  if (diff.identical) {
    for (let i = 0; i < out.length; i++) out[i] = blame[i];
    return out;
  }
  for (const b of diff.blocks) {
    if (b.type !== 'equal') continue;
    for (let k = 0; k < b.incomingEnd - b.incomingStart; k++) out[b.incomingStart + k] = blame[b.localStart + k];
  }
  return out;
}

export const DEFAULT_FORMAT = '{author} r{rev} {date}';

export interface FormatContext {
  author?: string;
  revision?: number;
  date?: string;
  message?: string;
}

export function shortDate(iso?: string): string {
  return iso ? iso.slice(0, 10) : '';
}

/** Tokens: {author} {rev} {date} {message}. Uncommitted lines render as `uncommitted`. */
export function formatAnnotation(format: string, ctx: FormatContext | undefined, maxMessage = 40): string {
  if (!ctx || ctx.revision === undefined) return 'uncommitted';
  const msg = (ctx.message ?? '').split(/\r?\n/)[0];
  const message = msg.length > maxMessage ? `${msg.slice(0, maxMessage - 1)}\u2026` : msg;
  return (format || DEFAULT_FORMAT)
    .replace(/\{author\}/g, ctx.author ?? '?')
    .replace(/\{rev\}/g, String(ctx.revision))
    .replace(/\{date\}/g, shortDate(ctx.date))
    .replace(/\{message\}/g, message)
    .trim();
}

export interface BlameData {
  /** Revision key: last-changed revision of the file at BASE. */
  revision: number;
  lines: BlameLine[];
  baseText: string;
}

/** Cache per file and BASE content revision; drop a file (or all) after update/commit. */
export class BlameCache {
  private static readonly MAX = 40;
  private readonly map = new Map<string, BlameData>();
  private readonly inflight = new Map<string, Promise<BlameData>>();

  private static key(path: string, revision: number): string {
    return `${path.toLowerCase()}@${revision}`;
  }

  get(path: string, revision: number): BlameData | undefined {
    return this.map.get(BlameCache.key(path, revision));
  }

  async getOrLoad(path: string, revision: number, load: () => Promise<BlameData>): Promise<BlameData> {
    const k = BlameCache.key(path, revision);
    const hit = this.map.get(k);
    if (hit) return hit;
    let p = this.inflight.get(k);
    if (!p) {
      p = load()
        .then((d) => {
          this.map.set(k, d);
          if (this.map.size > BlameCache.MAX) this.map.delete(this.map.keys().next().value as string);
          return d;
        })
        .finally(() => this.inflight.delete(k));
      this.inflight.set(k, p);
    }
    return p;
  }

  invalidate(path?: string): void {
    if (!path) {
      this.map.clear();
      return;
    }
    const prefix = `${path.toLowerCase()}@`;
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.map.delete(k);
  }

  get size(): number {
    return this.map.size;
  }
}

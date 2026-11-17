import { parseXml } from './xml';

export interface ListEntry {
  name: string;
  kind: 'file' | 'dir';
  size?: number;
  revision?: number;
  author?: string;
  date?: string;
}

/** `svn list --xml`: directories first, then files, each case-insensitively sorted. */
export function parseList(xml: string): ListEntry[] {
  const doc = parseXml(xml);
  const raw = doc?.lists?.list;
  const lists = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: ListEntry[] = [];
  for (const l of lists) {
    const entries = l?.entry === undefined ? [] : Array.isArray(l.entry) ? l.entry : [l.entry];
    for (const e of entries) {
      const name = typeof e.name === 'string' ? e.name : String(e.name ?? '');
      if (!name) continue;
      out.push({
        name,
        kind: e['@_kind'] === 'dir' ? 'dir' : 'file',
        size: e.size !== undefined ? Number(e.size) : undefined,
        revision: e.commit?.['@_revision'] !== undefined ? Number(e.commit['@_revision']) : undefined,
        author: typeof e.commit?.author === 'string' ? e.commit.author : undefined,
        date: typeof e.commit?.date === 'string' ? e.commit.date : undefined,
      });
    }
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.kind === 'dir' ? -1 : 1));
}


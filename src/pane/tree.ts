import * as path from 'node:path';
import { ChangeItem, PathFlavour } from '../incoming/model';

export type ViewMode = 'tree' | 'list';

export function parseViewMode(v: unknown): ViewMode {
  return v === 'list' ? 'list' : 'tree';
}

export interface TreeFolder {
  kind: 'folder';
  /** Display name; single-child chains are joined with "/" (compact folders). */
  name: string;
  /** Absolute path of the deepest folder of the chain. */
  path: string;
  /** Every item at or below the folder. */
  items: ChangeItem[];
  children: TreeEntry[];
}
export interface TreeLeaf {
  kind: 'item';
  item: ChangeItem;
}
export type TreeEntry = TreeFolder | TreeLeaf;

interface Trie {
  name: string;
  path: string;
  own?: ChangeItem;
  kids: Map<string, Trie>;
}

function segmentsOf(root: string, p: string, o: PathFlavour): string[] {
  const pp = (o.platform ?? (process.platform === 'win32' ? 'win32' : 'posix')) === 'win32' ? path.win32 : path.posix;
  return pp.relative(root, p).split(/[\\/]/).filter(Boolean);
}

/**
 * Folder hierarchy of items below `root`. An item that has other items beneath it (a changed folder) is
 * shown as the folder itself. A folder holding exactly one sub-folder and nothing else is merged with it.
 */
export function buildTree(items: readonly ChangeItem[], root: string, o: PathFlavour = {}): TreeEntry[] {
  const top: Trie = { name: '', path: root, kids: new Map() };
  const win = (o.platform ?? process.platform) === 'win32';
  const join = win ? path.win32.join : path.posix.join;
  for (const item of items) {
    const segs = segmentsOf(root, item.path, o);
    let cur = top;
    segs.forEach((seg, idx) => {
      const key = win ? seg.toLowerCase() : seg;
      let next = cur.kids.get(key);
      if (!next) {
        next = { name: seg, path: join(cur.path, seg), kids: new Map() };
        cur.kids.set(key, next);
      }
      cur = next;
      if (idx === segs.length - 1) cur.own = item;
    });
  }
  const collect = (t: Trie): ChangeItem[] => [...(t.own ? [t.own] : []), ...[...t.kids.values()].flatMap(collect)];
  const convert = (t: Trie): TreeEntry => {
    if (!t.kids.size && t.own) return { kind: 'item', item: t.own };
    let name = t.name;
    let node = t;
    while (node.kids.size === 1 && !node.own) {
      const only = [...node.kids.values()][0];
      if (!only.kids.size) break;
      name += `/${only.name}`;
      node = only;
    }
    return { kind: 'folder', name, path: node.path, items: collect(node), children: sortEntries([...node.kids.values()].map(convert)) };
  };
  return sortEntries([...top.kids.values()].map(convert));
}

function sortEntries(list: TreeEntry[]): TreeEntry[] {
  const nameOf = (e: TreeEntry): string => (e.kind === 'folder' ? e.name : path.basename(e.item.path));
  return list.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1) || nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base' }));
}

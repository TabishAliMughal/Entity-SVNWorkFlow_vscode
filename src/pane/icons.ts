import { ChangeItem } from '../incoming/model';

export type Direction = 'in' | 'out' | 'both';
export type Mark = 'none' | 'add' | 'del' | 'replace' | 'conflict' | 'unversioned' | 'missing';

export interface PaneIcon {
  dir: Direction;
  mark: Mark;
}

export const DIRECTIONS: readonly Direction[] = ['in', 'out', 'both'];
export const MARKS: readonly Mark[] = ['none', 'add', 'del', 'replace', 'conflict', 'unversioned', 'missing'];

function markOf(status: string | undefined): Mark {
  switch (status) {
    case 'added':
      return 'add';
    case 'deleted':
      return 'del';
    case 'replaced':
      return 'replace';
    case 'conflicted':
      return 'conflict';
    case 'unversioned':
      return 'unversioned';
    case 'missing':
      return 'missing';
    default:
      return 'none';
  }
}

/**
 * Direction arrow(s) (outgoing = up, incoming = down) plus a mark for the kind of change; an added file
 * is "+" with the arrow. The mark comes from the local status, or the server status for incoming-only items.
 */
export function paneIcon(i: Pick<ChangeItem, 'item' | 'outgoing' | 'incoming' | 'treeConflicted' | 'repoItem'>): PaneIcon {
  const dir: Direction = i.outgoing && i.incoming ? 'both' : i.incoming ? 'in' : 'out';
  if (i.treeConflicted) return { dir, mark: 'conflict' };
  const mark = i.outgoing ? markOf(i.item) : markOf(i.repoItem);
  return { dir, mark };
}

export function iconFile(icon: PaneIcon, theme: 'light' | 'dark'): string {
  return `media/pane/${icon.dir}-${icon.mark}-${theme}.svg`;
}

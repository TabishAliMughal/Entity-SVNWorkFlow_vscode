import * as path from 'node:path';
import { ChangeItem } from '../incoming/model';

export type PaneFilter = 'outgoing' | 'incoming' | 'all';
export const PANE_FILTERS: readonly PaneFilter[] = ['outgoing', 'incoming', 'all'];

export function parseFilter(v: unknown): PaneFilter {
  return v === 'outgoing' || v === 'incoming' || v === 'all' ? v : 'all';
}

export function matchesFilter(item: Pick<ChangeItem, 'outgoing' | 'incoming'>, filter: PaneFilter): boolean {
  if (filter === 'outgoing') return item.outgoing;
  if (filter === 'incoming') return item.incoming;
  return item.outgoing || item.incoming;
}

export function filterItems<T extends Pick<ChangeItem, 'outgoing' | 'incoming'>>(items: readonly T[], filter: PaneFilter): T[] {
  return items.filter((i) => matchesFilter(i, filter));
}

/** `<filename> (<last committer>)`, or just the filename while the author is unknown. */
export function buildLabel(fileName: string, author: string | undefined): string {
  return author ? `${fileName} (${author})` : fileName;
}

export function relativeDescription(itemPath: string, repoRoot: string): string {
  const rel = path.relative(repoRoot, itemPath);
  return rel.split(path.sep).join('/');
}

/** Status shown in the tooltip; a local change wins over an incoming-only item. */
export function statusText(i: Pick<ChangeItem, 'item' | 'props' | 'repoItem' | 'repoProps' | 'outgoing' | 'incoming'>): string {
  const parts: string[] = [];
  if (i.outgoing) parts.push(i.item !== 'normal' ? `Local: ${i.item}` : `Local: properties ${i.props}`);
  if (i.incoming) parts.push(`Incoming: ${i.repoItem && i.repoItem !== 'none' ? i.repoItem : `properties ${i.repoProps}`}`);
  return parts.join(' | ');
}

export interface IconSpec {
  id: string;
  /** Theme color id. */
  color?: string;
}

export function statusIcon(i: Pick<ChangeItem, 'item' | 'outgoing' | 'incoming'>): IconSpec {
  switch (i.item) {
    case 'modified':
      return { id: 'diff-modified', color: 'gitDecoration.modifiedResourceForeground' };
    case 'added':
      return { id: 'diff-added', color: 'gitDecoration.addedResourceForeground' };
    case 'deleted':
      return { id: 'diff-removed', color: 'gitDecoration.deletedResourceForeground' };
    case 'replaced':
      return { id: 'diff-renamed', color: 'gitDecoration.modifiedResourceForeground' };
    case 'unversioned':
      return { id: 'question', color: 'gitDecoration.untrackedResourceForeground' };
    case 'missing':
      return { id: 'warning', color: 'list.warningForeground' };
    case 'conflicted':
      return { id: 'error', color: 'list.errorForeground' };
    default:
      return i.incoming ? { id: 'cloud-download', color: 'gitDecoration.modifiedResourceForeground' } : { id: 'circle-outline' };
  }
}

/**
 * Space separated flags for the tree item contextValue, so menus can match with
 * `viewItem =~ /\bincoming\b/`. Always starts with `svnItem`.
 */
export function contextValueFor(i: Pick<ChangeItem, 'item' | 'outgoing' | 'incoming'> & { changelist?: string }, isDir: boolean): string {
  const flags = ['svnItem', i.item];
  if (i.outgoing) flags.push('outgoing');
  if (i.incoming) flags.push('incoming');
  if (i.changelist) flags.push('inChangelist');
  flags.push(isDir ? 'dir' : 'file');
  return flags.join(' ');
}

export const FILTER_TITLES: Record<PaneFilter, string> = { outgoing: 'Outgoing', incoming: 'Incoming', all: 'All' };

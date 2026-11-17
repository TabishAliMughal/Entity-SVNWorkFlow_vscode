import { ChangeItem } from '../incoming/model';

export const DEFAULT_GROUP = 'Changes';

export interface ChangeGroup<T> {
  /** Changelist name; undefined for the default "Changes" group. */
  changelist?: string;
  title: string;
  items: T[];
}

/**
 * Groups items by changelist: the default "Changes" group first (only when it has items), then each
 * changelist alphabetically. Returns [] when no item belongs to a changelist and `onlyWhenUsed` is set,
 * so the pane can stay flat for users who never use changelists.
 */
export function groupByChangelist<T extends Pick<ChangeItem, 'changelist'>>(items: readonly T[], onlyWhenUsed = false): ChangeGroup<T>[] {
  const named = new Map<string, T[]>();
  const plain: T[] = [];
  for (const i of items) {
    if (i.changelist) {
      const list = named.get(i.changelist) ?? [];
      list.push(i);
      named.set(i.changelist, list);
    } else plain.push(i);
  }
  if (onlyWhenUsed && !named.size) return [];
  const out: ChangeGroup<T>[] = [];
  if (plain.length) out.push({ title: DEFAULT_GROUP, items: plain });
  for (const name of [...named.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))) out.push({ changelist: name, title: name, items: named.get(name) ?? [] });
  return out;
}

/** svn accepts nearly anything, but names must be non-empty, single-line and not look like an option. */
export function validateChangelistName(name: string): string | undefined {
  const n = name.trim();
  if (!n) return 'A changelist name is required';
  if (/[\r\n\0]/.test(n)) return 'The name must be a single line';
  if (n.startsWith('-')) return 'The name must not start with "-"';
  if (/[*?]/.test(n)) return 'The name must not contain "*" or "?" (svn.exe on Windows expands wildcards)';
  if (n.length > 128) return 'The name is too long (max 128 characters)';
  if (n === DEFAULT_GROUP) return `"${DEFAULT_GROUP}" is the default group; pick another name`;
  return undefined;
}

/** Changelist names found in a list of items/entries, sorted. */
export function changelistNames(items: readonly { changelist?: string }[]): string[] {
  return [...new Set(items.map((i) => i.changelist).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

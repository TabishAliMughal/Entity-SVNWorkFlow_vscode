import * as path from 'node:path';
import { ChangeItem, isSameOrUnder, pathKey } from '../incoming/model';

/** True when `p` is a listed path or lies beneath a listed folder. */
export function isLocalIgnored(p: string, list: readonly string[]): boolean {
  return list.some((l) => isSameOrUnder(p, l));
}

export function partitionLocalIgnored<T extends Pick<ChangeItem, 'path'>>(items: readonly T[], list: readonly string[]): { kept: T[]; ignored: T[] } {
  if (!list.length) return { kept: [...items], ignored: [] };
  const kept: T[] = [];
  const ignored: T[] = [];
  for (const i of items) (isLocalIgnored(i.path, list) ? ignored : kept).push(i);
  return { kept, ignored };
}

export function addToList(list: readonly string[], paths: readonly string[]): string[] {
  const seen = new Set(list.map((p) => pathKey(p)));
  const out = [...list];
  for (const p of paths) {
    if (seen.has(pathKey(p))) continue;
    seen.add(pathKey(p));
    out.push(path.normalize(p));
  }
  return out;
}

export function removeFromList(list: readonly string[], paths: readonly string[]): string[] {
  const drop = new Set(paths.map((p) => pathKey(p)));
  return list.filter((p) => !drop.has(pathKey(p)));
}

/**
 * Update targets that cannot touch locally ignored files. A target that is (inside) an ignored path is dropped;
 * a folder containing ignored paths is replaced by the incoming items under it (`items` never holds ignored ones).
 * shortcut: an incoming add whose parent folder is missing locally still falls back to the parent in updatePaths, which the guard then rejects.
 */
export function expandUpdatePaths(paths: readonly string[], items: readonly Pick<ChangeItem, 'path' | 'incoming'>[], list: readonly string[]): string[] {
  const out = new Map<string, string>();
  for (const p of paths) {
    if (isLocalIgnored(p, list)) continue;
    if (!list.some((l) => isSameOrUnder(l, p))) out.set(pathKey(p), p);
    else for (const i of items) if (i.incoming && isSameOrUnder(i.path, p)) out.set(pathKey(i.path), i.path);
  }
  return [...out.values()];
}

let source: () => readonly string[] = () => [];

/** Installed once by the extension; lets low-level operations (update, override) refuse to touch ignored files. */
export function setLocalIgnoreSource(fn: () => readonly string[]): void {
  source = fn;
}

export class LocalIgnoreError extends Error {
  constructor(public readonly hits: string[]) {
    super(`Refusing to touch the Local Ignore List: ${hits.slice(0, 5).map((h) => path.basename(h)).join(', ')}${hits.length > 5 ? ', ...' : ''}. Remove the file(s) from the list first, or pick specific files.`);
    this.name = 'LocalIgnoreError';
  }
}

/** Throws when any target is, contains or lies inside a locally ignored path (svn would update/revert/commit it with the folder). */
export function assertNoLocalIgnored(targets: readonly string[]): void {
  const hits = localIgnoredAround(targets);
  if (hits.length) throw new LocalIgnoreError(hits);
}

/** Listed paths that are, contain or lie inside one of the targets. */
export function localIgnoredAround(targets: readonly string[], list: readonly string[] = source()): string[] {
  return list.filter((l) => targets.some((t) => isSameOrUnder(l, t) || isSameOrUnder(t, l)));
}

export const currentLocalIgnoreList = (): readonly string[] => source();

/**
 * Revert candidates that cannot touch locally ignored files: ignored ones are dropped and a folder with a listed
 * path beneath it loses `isDir`, so planRevert reverts it non-recursively instead of with -R.
 */
export function skipLocalIgnoredRevert<T extends { path: string; isDir?: boolean }>(cands: readonly T[], list: readonly string[]): T[] {
  return cands.filter((c) => !isLocalIgnored(c.path, list)).map((c) => (c.isDir && list.some((l) => isSameOrUnder(l, c.path)) ? { ...c, isDir: false } : c));
}

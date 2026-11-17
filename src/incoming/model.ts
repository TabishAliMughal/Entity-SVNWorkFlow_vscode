import * as path from 'node:path';
import { LockInfo, StatusEntry } from '../svn/xml';

export interface PathFlavour {
  platform?: 'win32' | 'posix';
}

function flavour(o: PathFlavour): { p: path.PlatformPath; ci: boolean } {
  const platform = o.platform ?? (process.platform === 'win32' ? 'win32' : 'posix');
  return { p: platform === 'win32' ? path.win32 : path.posix, ci: platform === 'win32' };
}

/** Comparison key: normalized, no trailing separator, case-folded on Windows. */
export function pathKey(input: string, o: PathFlavour = {}): string {
  const { p, ci } = flavour(o);
  let n = p.normalize(input);
  const root = p.parse(n).root;
  while (n.length > root.length && /[\\/]$/.test(n)) n = n.slice(0, -1);
  return ci ? n.toLowerCase() : n;
}

/** True when child equals parent or lies beneath it. */
export function isSameOrUnder(child: string, parent: string, o: PathFlavour = {}): boolean {
  const { p } = flavour(o);
  const c = pathKey(child, o);
  const r = pathKey(parent, o);
  return c === r || c.startsWith(r.endsWith(p.sep) ? r : r + p.sep);
}

const OUTGOING_ITEMS = new Set(['modified', 'added', 'deleted', 'unversioned', 'missing', 'conflicted', 'replaced', 'obstructed', 'incomplete']);
const INCOMING_ITEMS = new Set(['added', 'modified', 'deleted', 'replaced']);

export interface ChangeItem {
  repoName: string;
  /** Absolute path. */
  path: string;
  /** Local item status (svn wc-status item). */
  item: string;
  props: string;
  /** svn status tree-conflicted flag (item/props can look unconflicted). */
  treeConflicted?: boolean;
  /** Working-copy revision of the item (BASE), when versioned. */
  revision?: number;
  /** Server-side status; set when the last remote check saw a newer revision. */
  repoItem?: string;
  repoProps?: string;
  outgoing: boolean;
  incoming: boolean;
  changelist?: string;
  /** Lock token held by this working copy. */
  lock?: LockInfo;
  /** Lock held on the server (seen by the last remote check). */
  repoLock?: LockInfo;
}

export function isOutgoingStatus(item: string, props: string | undefined, treeConflicted?: boolean): boolean {
  return OUTGOING_ITEMS.has(item) || props === 'modified' || props === 'conflicted' || !!treeConflicted;
}

export function isIncomingStatus(repoItem: string | undefined, repoProps: string | undefined): boolean {
  return (repoItem !== undefined && INCOMING_ITEMS.has(repoItem)) || repoProps === 'modified' || repoProps === 'conflicted';
}

export interface RemoteInfo {
  path: string;
  repoItem?: string;
  repoProps?: string;
  revision?: number;
}

/** Builds items from a status run; `remote` supplies server-side info (from this or a previous -u check). */
export function buildItems(repoName: string, entries: readonly StatusEntry[], remote: ReadonlyMap<string, RemoteInfo>, resolveAbs: (p: string) => string, o: PathFlavour = {}): ChangeItem[] {
  const byKey = new Map<string, ChangeItem>();
  const add = (abs: string, e: { item: string; props: string; treeConflicted?: boolean; revision?: number; changelist?: string; lock?: LockInfo; repoLock?: LockInfo }): void => {
    const key = pathKey(abs, o);
    const r = remote.get(key);
    const outgoing = isOutgoingStatus(e.item, e.props, e.treeConflicted);
    const incoming = isIncomingStatus(r?.repoItem, r?.repoProps);
    if (!outgoing && !incoming) return;
    byKey.set(key, { repoName, path: abs, item: e.item, props: e.props, treeConflicted: e.treeConflicted, revision: e.revision, repoItem: r?.repoItem, repoProps: r?.repoProps, outgoing, incoming, changelist: e.changelist, lock: e.lock, repoLock: e.repoLock });
  };
  for (const e of entries) add(resolveAbs(e.path), e);
  // Incoming items that a local-only status run did not list (unchanged locally).
  for (const [key, r] of remote) {
    if (!byKey.has(key)) add(r.path, { item: 'normal', props: 'none', revision: r.revision });
  }
  return [...byKey.values()];
}

export function remoteMapFrom(entries: readonly StatusEntry[], resolveAbs: (p: string) => string, o: PathFlavour = {}): Map<string, RemoteInfo> {
  const m = new Map<string, RemoteInfo>();
  for (const e of entries) {
    if (isIncomingStatus(e.repoItem, e.repoProps)) m.set(pathKey(resolveAbs(e.path), o), { path: resolveAbs(e.path), repoItem: e.repoItem, repoProps: e.repoProps, revision: e.revision });
  }
  return m;
}

/**
 * All paths that count as "has incoming changes": each incoming item plus every
 * ancestor folder up to and including the repo root.
 */
export function aggregateIncoming(incomingPaths: readonly string[], root: string, o: PathFlavour = {}): string[] {
  const { p } = flavour(o);
  const out = new Map<string, string>();
  for (const item of incomingPaths) {
    let cur = item;
    for (;;) {
      const key = pathKey(cur, o);
      if (out.has(key)) break;
      out.set(key, cur);
      if (key === pathKey(root, o) || !isSameOrUnder(cur, root, o)) break;
      const parent = p.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return [...out.values()];
}

export function authorCacheable(item: ChangeItem): boolean {
  return item.item !== 'unversioned' && item.item !== 'added' && item.revision !== undefined;
}

export class NoIncomingError extends Error {
  constructor(public readonly target: string) {
    super(
      `"${path.basename(target) || target}" has no incoming changes: the server has no newer revision for it (or for anything under it). ` +
        'This action is only available for items with incoming changes. Use "Refresh" in the SVN view to check the server again.',
    );
    this.name = 'NoIncomingError';
  }
}

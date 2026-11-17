import * as path from 'node:path';
import { isSameOrUnder, pathKey } from '../incoming/model';

/** One row of the commit dialog. */
export interface CommitEntry {
  repoName: string;
  /** Absolute path. */
  path: string;
  item: string;
  props: string;
  changelist?: string;
  isDir?: boolean;
  /** Lock held by this working copy (shown as a hint; kept unless "keep locks" is off). */
  locked?: boolean;
}

export type EntryKind = 'commit' | 'unversioned' | 'blocked';

const COMMITTABLE = new Set(['modified', 'added', 'deleted', 'replaced']);

export function entryKind(e: Pick<CommitEntry, 'item' | 'props'>): EntryKind {
  if (e.item === 'unversioned') return 'unversioned';
  if (COMMITTABLE.has(e.item)) return 'commit';
  if (e.item === 'normal' && e.props === 'modified') return 'commit';
  return 'blocked';
}

/** Why a row cannot be committed, for the tooltip. */
export function blockedReason(e: Pick<CommitEntry, 'item'>): string {
  switch (e.item) {
    case 'conflicted':
      return 'Conflicted: resolve the conflict first';
    case 'missing':
      return 'Missing from disk: restore it or delete it with SVN first';
    case 'obstructed':
    case 'incomplete':
      return `Cannot commit an ${e.item} item`;
    default:
      return 'Not committable';
  }
}

/**
 * Initial check state. `scope` limits what is pre-checked (the paths the user right-clicked); no scope = every
 * committable item. Unversioned items stay unchecked unless the user pointed at that exact path.
 */
export function defaultChecked(entries: readonly CommitEntry[], scope?: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const e of entries) {
    const kind = entryKind(e);
    if (kind === 'blocked') continue;
    const inScope = !scope || scope.some((s) => isSameOrUnder(e.path, s));
    if (!inScope) continue;
    if (kind === 'unversioned' && !(scope && scope.some((s) => pathKey(s) === pathKey(e.path)))) continue;
    out.add(e.path);
  }
  return out;
}

export interface CommitPlan {
  repoName: string;
  /** Unversioned items to `svn add` first. */
  add: string[];
  /** Everything handed to `svn commit` (explicit targets, `--depth empty`), includes `add` and implied parents. */
  commit: string[];
  /** Added parent folders that were not checked but must go along with a checked child. */
  implied: string[];
  /** Selected paths that cannot be committed. */
  rejected: string[];
}

/** Turns the checked paths of one repo into add/commit lists. */
export function buildPlan(repoName: string, entries: readonly CommitEntry[], selected: ReadonlySet<string> | readonly string[]): CommitPlan {
  const sel = new Set([...selected].map((p) => pathKey(p)));
  const mine = entries.filter((e) => e.repoName === repoName);
  const plan: CommitPlan = { repoName, add: [], commit: [], implied: [], rejected: [] };
  const seen = new Set<string>();
  const push = (p: string): void => {
    const k = pathKey(p);
    if (!seen.has(k)) {
      seen.add(k);
      plan.commit.push(p);
    }
  };
  for (const e of mine) {
    if (!sel.has(pathKey(e.path))) continue;
    const kind = entryKind(e);
    if (kind === 'blocked') plan.rejected.push(e.path);
    else if (kind === 'unversioned') plan.add.push(e.path);
  }
  for (const e of mine) {
    if (!sel.has(pathKey(e.path)) || entryKind(e) === 'blocked') continue;
    push(e.path);
    // An added file can only be committed together with its added (not yet committed) parent folders.
    let dir = path.dirname(e.path);
    for (;;) {
      const parent = mine.find((x) => pathKey(x.path) === pathKey(dir));
      if (!parent) break;
      if (parent.item === 'added' && !seen.has(pathKey(parent.path))) {
        push(parent.path);
        plan.implied.push(parent.path);
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return plan;
}

export function validateCommit(message: string, plans: readonly CommitPlan[]): string | undefined {
  if (!plans.some((p) => p.commit.length)) return 'Select at least one file to commit';
  const bad = plans.flatMap((p) => p.rejected);
  if (bad.length) return `Cannot commit: ${bad.map((b) => path.basename(b)).join(', ')} (conflicted or missing)`;
  return undefined;
}

/** True for the svn failures that mean "someone committed first / file out of date". */
export function isOutOfDate(text: string): boolean {
  return /out of date|E160024|E155011|E170004|E160028/i.test(text);
}

/** Message history: newest first, no duplicates, capped. Blank messages are ignored. */
export function pushHistory(list: readonly string[], message: string, max: number): string[] {
  const m = message.trim();
  if (!m || max <= 0) return list.slice(0, Math.max(0, max));
  return [m, ...list.filter((x) => x !== m)].slice(0, max);
}

export function sanitizeHistory(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, Math.max(0, max));
}

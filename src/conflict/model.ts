import * as path from 'node:path';
import { isSameOrUnder, pathKey, type ChangeItem } from '../incoming/model';
import { parseXml } from '../svn/xml';

export type ConflictKind = 'text' | 'property' | 'tree';

/** The six `svn resolve --accept` choices that apply to text conflicts (and `working` to every kind). */
export type AcceptChoice = 'mine-full' | 'theirs-full' | 'mine-conflict' | 'theirs-conflict' | 'working' | 'base';

export const ACCEPT_CHOICES: ReadonlyArray<{ id: AcceptChoice; command: string; label: string; detail: string }> = [
  { id: 'mine-full', command: 'svnWorkflow.conflict.mineFull', label: 'Resolve using Mine (whole file)', detail: 'Keep your version of the whole file; incoming changes to it are dropped.' },
  { id: 'theirs-full', command: 'svnWorkflow.conflict.theirsFull', label: 'Resolve using Theirs (whole file)', detail: 'Take the incoming version of the whole file; your changes to it are dropped.' },
  { id: 'mine-conflict', command: 'svnWorkflow.conflict.mineConflict', label: 'Resolve using Mine (conflicting blocks only)', detail: 'Keep merged changes; in each conflicting block use your side.' },
  { id: 'theirs-conflict', command: 'svnWorkflow.conflict.theirsConflict', label: 'Resolve using Theirs (conflicting blocks only)', detail: 'Keep merged changes; in each conflicting block use the incoming side.' },
  { id: 'working', command: 'svnWorkflow.conflict.working', label: 'Mark as Resolved (use working file as it is)', detail: 'Use the file as it is now (after your manual edits) and clear the conflict.' },
  { id: 'base', command: 'svnWorkflow.conflict.base', label: 'Resolve using Base (the common ancestor)', detail: 'Discard both sides in favour of the version both started from.' },
];

export const ACCEPT_IDS: readonly AcceptChoice[] = ACCEPT_CHOICES.map((c) => c.id);

export function conflictKinds(i: Pick<ChangeItem, 'item' | 'props' | 'treeConflicted'>): ConflictKind[] {
  const k: ConflictKind[] = [];
  if (i.item === 'conflicted') k.push('text');
  if (i.props === 'conflicted') k.push('property');
  if (i.treeConflicted) k.push('tree');
  return k;
}

export function isConflicted(i: Pick<ChangeItem, 'item' | 'props' | 'treeConflicted'>): boolean {
  return conflictKinds(i).length > 0;
}

export function conflictedItems<T extends Pick<ChangeItem, 'item' | 'props' | 'treeConflicted'>>(items: readonly T[]): T[] {
  return items.filter(isConflicted);
}

/** Flags appended to a pane item's contextValue: `conflicted conflictText conflictProp conflictTree`. */
export function conflictFlags(i: Pick<ChangeItem, 'item' | 'props' | 'treeConflicted'>): string[] {
  const k = conflictKinds(i);
  if (!k.length) return [];
  const f = ['conflicted'];
  if (k.includes('text')) f.push('conflictText');
  if (k.includes('property')) f.push('conflictProp');
  if (k.includes('tree')) f.push('conflictTree');
  return f;
}

export function kindsLabel(kinds: readonly ConflictKind[]): string {
  return kinds.map((k) => (k === 'property' ? 'property' : k)).join(' + ');
}

/**
 * Expands command targets to the conflicted paths they cover: a conflicted target stands for itself, a folder
 * (or repo root) for every conflicted item under it.
 */
export function expandToConflicted(targets: readonly string[], conflicted: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of targets) for (const c of conflicted) if (isSameOrUnder(c, t)) out.add(c);
  return [...out];
}

export function summarizeConflicts(items: readonly Pick<ChangeItem, 'item' | 'props' | 'treeConflicted'>[]): { total: number; text: number; property: number; tree: number } {
  const r = { total: 0, text: 0, property: 0, tree: 0 };
  for (const i of items) {
    const k = conflictKinds(i);
    if (!k.length) continue;
    r.total++;
    if (k.includes('text')) r.text++;
    if (k.includes('property')) r.property++;
    if (k.includes('tree')) r.tree++;
  }
  return r;
}

// ---------- `svn info --xml` conflict data ----------

export interface VersionRef {
  side: 'source-left' | 'source-right';
  reposUrl: string;
  /** Repository-root relative path without a leading slash. */
  pathInRepos: string;
  revision?: number;
  kind?: string;
}

export interface TextConflictInfo {
  operation: string;
  baseFile?: string;
  mineFile?: string;
  theirsFile?: string;
}

export interface TreeConflictInfo {
  reason: string;
  action: string;
  operation: string;
  kind: string;
}

export interface ConflictInfo {
  path: string;
  nodeKind: string;
  /** Schedule of the node (`delete`, `add`, `normal`). */
  schedule?: string;
  text?: TextConflictInfo;
  property?: { operation: string; prejFile?: string };
  tree?: TreeConflictInfo;
  left?: VersionRef;
  right?: VersionRef;
}

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function versionOf(v: any): VersionRef | undefined { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!v) return undefined;
  return {
    side: v['@_side'],
    reposUrl: v['@_repos-url'] ?? '',
    pathInRepos: String(v['@_path-in-repos'] ?? ''),
    revision: v['@_revision'] !== undefined ? Number(v['@_revision']) : undefined,
    kind: v['@_kind'],
  };
}

/** Conflict details of every entry of `svn info --xml <paths>`; entries without a conflict are skipped. */
export function parseConflictInfo(xml: string): ConflictInfo[] {
  const doc = parseXml(xml);
  const out: ConflictInfo[] = [];
  for (const e of arr<any>(doc?.info?.entry)) { // eslint-disable-line @typescript-eslint/no-explicit-any
    const conflicts = arr<any>(e.conflict); // eslint-disable-line @typescript-eslint/no-explicit-any
    const tree = e['tree-conflict'];
    if (!conflicts.length && !tree) continue;
    const info: ConflictInfo = { path: e['@_path'], nodeKind: e['@_kind'], schedule: e['wc-info']?.schedule };
    for (const c of conflicts) {
      const versions = arr<any>(c.version).map(versionOf); // eslint-disable-line @typescript-eslint/no-explicit-any
      info.left ??= versions.find((v) => v?.side === 'source-left');
      info.right ??= versions.find((v) => v?.side === 'source-right');
      if (c['@_type'] === 'text') {
        info.text = { operation: c['@_operation'], baseFile: c['prev-base-file'], mineFile: c['prev-wc-file'], theirsFile: c['cur-base-file'] };
      } else if (c['@_type'] === 'property') {
        info.property = { operation: c['@_operation'], prejFile: c['prop-file'] };
      }
    }
    if (tree) {
      const versions = arr<any>(tree.version).map(versionOf); // eslint-disable-line @typescript-eslint/no-explicit-any
      info.left ??= versions.find((v) => v?.side === 'source-left');
      info.right ??= versions.find((v) => v?.side === 'source-right');
      info.tree = { reason: tree['@_reason'], action: tree['@_action'], operation: tree['@_operation'], kind: tree['@_kind'] };
    }
    out.push(info);
  }
  return out;
}

/** `^/path@rev` style URL of a version, for `svn cat` / `propget` (peg revision included). */
export function versionUrl(v: VersionRef): string {
  const p = v.pathInRepos.split('/').map(encodeURIComponent).join('/');
  return `${v.reposUrl.replace(/\/+$/, '')}/${p}${v.revision !== undefined ? `@${v.revision}` : ''}`;
}

// ---------- property conflicts ----------

/** Property names mentioned by a `.prej` file ("Trying to change property 'k'"). */
export function parsePrejProps(prej: string): string[] {
  const out = new Set<string>();
  for (const m of prej.matchAll(/(?:Trying to|Failed to|Cannot|Could not)[^\n']*property '([^']+)'/gi)) out.add(m[1]);
  for (const m of prej.matchAll(/^Conflict(?:ing)? (?:in )?propert(?:y|ies)[^'\n]*'([^']+)'/gim)) out.add(m[1]);
  return [...out];
}

// ---------- tree conflicts ----------

const WORDS: Record<string, string> = {
  edit: 'edit',
  delete: 'delete',
  add: 'add',
  replace: 'replace',
  missing: 'missing',
  obstruction: 'obstruction',
  'moved-away': 'move',
  'moved-here': 'move',
  unversioned: 'unversioned item',
};

/** svn's own phrasing: "local file delete, incoming file edit upon update". */
export function describeTreeConflict(t: TreeConflictInfo): string {
  const kind = t.kind === 'dir' ? 'dir' : 'file';
  const reason = t.reason === 'moved-away' ? 'moved away' : t.reason === 'moved-here' ? 'moved here' : (WORDS[t.reason] ?? t.reason);
  const action = t.action === 'delete' ? 'delete or move' : (WORDS[t.action] ?? t.action);
  return `Local ${kind} ${reason}, incoming ${kind} ${action} upon ${t.operation}`;
}

export type TreeStep =
  | { op: 'resolve'; accept: 'working' | 'mine-conflict' | 'theirs-conflict' }
  | { op: 'revert' }
  | { op: 'deleteForce' }
  | { op: 'removeFromDisk' }
  | { op: 'update' };

export interface TreeOption {
  id: string;
  label: string;
  /** What it does, in plain words. */
  detail: string;
  steps: TreeStep[];
  /** Loses local content or work: ask for confirmation first. */
  destructive?: boolean;
  /** Needs a recent svn and a matching kind of change; may report "inapplicable". */
  experimental?: boolean;
}

export interface TreeAdvice {
  summary: string;
  options: TreeOption[];
  /** Manual cleanup guidance. */
  guidance: string[];
}

const markResolved: TreeOption = {
  id: 'working',
  label: 'Mark as resolved (leave the working copy as it is)',
  detail: 'Runs svn resolve --accept working. Use after you fixed the tree by hand.',
  steps: [{ op: 'resolve', accept: 'working' }],
};

/**
 * Resolution options for a tree conflict. svn 1.14 only supports `--accept working` for plain tree conflicts
 * (mine-conflict / theirs-conflict need a move), so "accept incoming" and "keep local" are recipes: bring the
 * working copy into the wanted shape (revert, delete), then mark the conflict resolved.
 */
export function treeAdvice(t: TreeConflictInfo): TreeAdvice {
  const summary = describeTreeConflict(t);
  const dir = t.kind === 'dir';
  const what = dir ? 'folder' : 'file';
  const options: TreeOption[] = [];
  const guidance: string[] = [];
  const key = `${t.reason}/${t.action}`;

  if (t.reason === 'edit' && (t.action === 'delete' || t.action === 'replace')) {
    options.push({
      id: 'keep-local',
      label: `Keep my ${what} (with my changes)`,
      detail: `The ${what} stays as a local addition and will be committed again, so the incoming delete is undone for it.`,
      steps: [{ op: 'resolve', accept: 'working' }],
    });
    options.push({
      id: 'accept-delete',
      label: `Accept the incoming delete (remove my ${what})`,
      detail: `Deletes the ${what} from disk and from version control, discarding your local edits to it.`,
      steps: [{ op: 'resolve', accept: 'working' }, { op: 'deleteForce' }],
      destructive: true,
    });
    options.push({
      id: 'follow-move',
      label: 'Incoming change was a move: apply my edits to the moved item',
      detail: 'Runs svn resolve --accept mine-conflict. Works only when the server side renamed or moved the item.',
      steps: [{ op: 'resolve', accept: 'mine-conflict' }],
      experimental: true,
    });
    guidance.push('If the incoming change was a rename, use "svn log -v" on the parent to find the new path, copy your edits there and then accept the delete.');
  } else if (t.reason === 'delete' && (t.action === 'edit' || t.action === 'replace' || t.action === 'add')) {
    options.push({
      id: 'keep-delete',
      label: `Keep my delete (drop the incoming change)`,
      detail: `The ${what} stays scheduled for deletion; the incoming edit is not applied to the working copy.`,
      steps: [{ op: 'resolve', accept: 'working' }],
    });
    options.push({
      id: 'accept-incoming',
      label: `Restore the ${what} with the incoming changes`,
      detail: `Reverts my delete so the ${what} comes back in its incoming state, then clears the conflict.`,
      steps: [{ op: 'revert' }],
    });
    guidance.push('If you deleted it because it was renamed locally, restore it, then redo your rename with svn move.');
  } else if (t.reason === 'delete' && t.action === 'delete') {
    options.push({ ...markResolved, label: 'Mark as resolved (both sides deleted it)', detail: 'Both you and the server deleted this item; nothing else is needed.' });
  } else if (t.reason === 'missing') {
    options.push({
      id: 'restore',
      label: `Restore the ${what} from the repository`,
      detail: `Reverts the missing ${what} to its repository state (including the incoming change), then clears the conflict.`,
      steps: [{ op: 'revert' }],
    });
    options.push({
      id: 'keep-missing',
      label: `Keep it removed (schedule a delete)`,
      detail: `Accepts that the ${what} is gone locally and marks the conflict resolved; commit to delete it on the server.`,
      steps: [{ op: 'resolve', accept: 'working' }, { op: 'deleteForce' }],
      destructive: true,
    });
    guidance.push('A missing item was removed outside svn (or moved without svn move). If you moved it, use svn move from the new location or restore it first.');
  } else if (t.reason === 'add' && t.action === 'add') {
    options.push({
      id: 'keep-local-add',
      label: 'Keep my added item',
      detail: 'Marks the conflict resolved with your item in place. A later commit may fail with "already exists" until the paths are reconciled.',
      steps: [{ op: 'resolve', accept: 'working' }],
    });
    options.push({
      id: 'take-incoming-add',
      label: 'Take the incoming item (discard my added one)',
      detail: 'Reverts my add, deletes my item from disk and updates the path so the incoming item appears.',
      steps: [{ op: 'revert' }, { op: 'removeFromDisk' }, { op: 'update' }],
      destructive: true,
    });
    guidance.push('To keep both, rename mine first (svn move to a new name), then take the incoming item.');
  } else if (t.reason === 'obstruction' || t.reason === 'unversioned') {
    guidance.push('An unversioned item of the same name is in the way of an incoming add. Move or delete it, run Update on the path to bring in the incoming item, then mark resolved.');
  } else if (t.reason === 'moved-away' || t.reason === 'moved-here') {
    options.push({
      id: 'move-target',
      label: 'Apply the incoming change to the moved item (my move stays)',
      detail: 'Runs svn resolve --accept mine-conflict.',
      steps: [{ op: 'resolve', accept: 'mine-conflict' }],
      experimental: true,
    });
    options.push({
      id: 'break-move',
      label: 'Apply the incoming change at the original path (my move becomes copy + delete)',
      detail: 'Runs svn resolve --accept theirs-conflict.',
      steps: [{ op: 'resolve', accept: 'theirs-conflict' }],
      experimental: true,
    });
  } else {
    guidance.push(`No automatic recipe for "${key}". Fix the tree with svn commands (revert, delete, move, update), then mark it resolved.`);
  }
  options.push(markResolved);
  guidance.push('Marking a tree conflict resolved does not change files: it only records that the working copy is in the shape you want.');
  const seen = new Set<string>();
  return { summary, options: options.filter((o) => (seen.has(o.id) ? false : (seen.add(o.id), true))), guidance };
}

export function relativeTo(root: string, p: string): string {
  return path.relative(root, p).split(path.sep).join('/') || path.basename(p);
}

const ARTIFACT_SUFFIX = /\.(?:mine|working|r\d+|merge-left\.r\d+|merge-right\.r\d+|prej)$/i;

/**
 * Unversioned files svn leaves next to conflicted items (`.mine`, `.rNNN`, `.working`, `.merge-left.rN`, `.prej`,
 * `dir_conflicts.prej`); the pane hides them while the conflict is open.
 */
export function conflictArtifacts<T extends Pick<ChangeItem, 'path' | 'item' | 'props' | 'treeConflicted'>>(items: readonly T[]): Set<T> {
  const conflicted = items.filter(isConflicted).map((i) => pathKey(i.path));
  const out = new Set<T>();
  if (!conflicted.length) return out;
  const set = new Set(conflicted);
  for (const i of items) {
    if (i.item !== 'unversioned') continue;
    const key = pathKey(i.path);
    const m = ARTIFACT_SUFFIX.exec(key);
    if (m && set.has(key.slice(0, m.index))) out.add(i);
    else if (/[\\/]dir_conflicts\.prej$/i.test(key) && set.has(pathKey(path.dirname(i.path)))) out.add(i);
  }
  return out;
}

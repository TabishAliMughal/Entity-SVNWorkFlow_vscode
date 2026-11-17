import * as path from 'node:path';
import { isSameOrUnder, pathKey } from '../incoming/model';
import { normalizeUrl } from '../repos/model';
import { encodeSvnUrl, encodeUrlPath } from '../util/svnUrl';

export type Depth = 'empty' | 'files' | 'immediates' | 'infinity';
export type SetDepth = Depth | 'exclude';

export const DEPTH_CHOICES: ReadonlyArray<{ depth: Depth; label: string; description: string }> = [
  { depth: 'infinity', label: 'Fully recursive', description: 'everything (default)' },
  { depth: 'immediates', label: 'Immediate children', description: 'files and empty sub-folders' },
  { depth: 'files', label: 'Only file children', description: 'files directly in the folder' },
  { depth: 'empty', label: 'Only this folder', description: 'no content (add parts later with Set Depth)' },
];

const GENERIC_SEGMENTS = new Set(['trunk', 'branches', 'tags', 'svn', 'repos', 'repo', 'src']);

/** Default repository entry name for a checkout URL: last meaningful path segment, else the host. */
export function deriveRepoName(url: string): string {
  let segs: string[];
  let host = '';
  try {
    const u = new URL(url);
    host = u.hostname;
    segs = u.pathname.split('/').map((s) => decodeURIComponent(s)).filter(Boolean);
  } catch {
    segs = url.split('/').filter(Boolean);
  }
  // .../repo/branches/x or .../repo/tags/x -> repo
  const idx = segs.findIndex((s) => s === 'branches' || s === 'tags');
  if (idx > 0) segs = segs.slice(0, idx);
  const pick = [...segs].reverse().find((s) => !GENERIC_SEGMENTS.has(s.toLowerCase())) ?? segs[segs.length - 1];
  return pick || host || 'repository';
}

/** `name`, `name-2`, `name-3`... until it differs from every existing name (case-insensitive). */
export function uniqueName(base: string, existing: readonly string[]): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`.toLowerCase())) return `${base}-${i}`;
}

/** Default target folder name for a checkout URL. */
export function defaultFolderName(url: string): string {
  return deriveRepoName(url).replace(/[<>:"|?*\\/]/g, '_');
}

/** Resolves `^/x` against the repository root; other input is returned normalized. */
export function resolveSvnUrl(input: string, repoRoot: string): string {
  const t = input.trim();
  if (t.startsWith('^/')) return normalizeUrl(`${repoRoot.replace(/\/+$/, '')}/${encodeUrlPath(t.slice(2))}`);
  if (t === '^') return normalizeUrl(repoRoot);
  return normalizeUrl(encodeSvnUrl(t));
}

/** Parses `svn list` output into directory names (entries ending in `/`). */
export function parseListDirs(text: string): string[] {
  return parseListAll(text).filter((e) => e.dir).map((e) => e.name);
}

export function parseListAll(text: string): Array<{ name: string; dir: boolean }> {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.endsWith('/') ? { name: l.slice(0, -1), dir: true } : { name: l, dir: false }));
}

/** The repo entry's serverUrl after the working copy root moved from oldRoot to newRoot. */
export function rebaseUrl(serverUrl: string, oldRoot: string, newRoot: string): string {
  const s = normalizeUrl(serverUrl);
  const o = normalizeUrl(oldRoot);
  const n = normalizeUrl(newRoot);
  if (s.toLowerCase() === o.toLowerCase()) return n;
  if (s.toLowerCase().startsWith(o.toLowerCase() + '/')) return n + s.slice(o.length);
  return n;
}

/** Validates the revision input of "Update to Revision": number, HEAD, BASE, PREV, COMMITTED or {date}. */
export function parseRevisionInput(input: string): { ok: true; rev: string } | { ok: false; error: string } {
  const t = input.trim();
  if (!t) return { ok: false, error: 'Enter a revision number, HEAD or a {YYYY-MM-DD} date.' };
  if (/^r?\d+$/i.test(t)) return { ok: true, rev: t.replace(/^r/i, '') };
  if (/^(HEAD|BASE|COMMITTED|PREV)$/i.test(t)) return { ok: true, rev: t.toUpperCase() };
  if (/^\{\d{4}-\d{2}-\d{2}([ T][\d:]+Z?)?\}$/.test(t)) return { ok: true, rev: t };
  return { ok: false, error: 'Use a revision number (e.g. 1234), HEAD, or a date like {2024-05-31}.' };
}

export interface RevertCandidate {
  path: string;
  item: string;
  props?: string;
  isDir?: boolean;
}

const NOT_REVERTABLE = new Set(['unversioned', 'ignored', 'normal', 'external', 'none', 'incomplete']);

/** Status entries that `svn revert` can act on. */
export function revertable<T extends { path: string; item: string; props?: string }>(entries: readonly T[]): T[] {
  return entries.filter((e) => !NOT_REVERTABLE.has(e.item) || e.props === 'modified' || e.props === 'conflicted');
}

export interface RevertStep {
  path: string;
  recursive: boolean;
}

/**
 * Turns the selected items into svn invocations. A directory is reverted with -R only if every candidate
 * beneath it is selected too, so unselected children are never touched. Children covered by a recursive
 * parent are dropped.
 */
export function planRevert(all: readonly RevertCandidate[], selected: ReadonlySet<string>): RevertStep[] {
  const chosen = all.filter((c) => selected.has(pathKey(c.path)));
  const steps: RevertStep[] = chosen.map((c) => {
    const below = all.filter((o) => pathKey(o.path) !== pathKey(c.path) && isSameOrUnder(o.path, c.path));
    const recursive = !!c.isDir && below.every((o) => selected.has(pathKey(o.path)));
    return { path: c.path, recursive };
  });
  return steps.filter((s) => !steps.some((o) => o.recursive && pathKey(o.path) !== pathKey(s.path) && isSameOrUnder(s.path, o.path)));
}

/** Deepest paths first, so reverting a child never happens after its parent was reverted away. */
export function revertOrder(steps: readonly RevertStep[]): RevertStep[] {
  return [...steps].sort((a, b) => b.path.length - a.path.length);
}

export interface CleanupOptions {
  vacuumPristines: boolean;
  includeExternals: boolean;
}

/** Plain `svn cleanup` removes the working copy write locks; the flags add pristine vacuuming / externals. */
export function cleanupArgs(o: CleanupOptions, targets: readonly string[]): string[] {
  const a = ['cleanup'];
  if (o.vacuumPristines) a.push('--vacuum-pristines');
  if (o.includeExternals) a.push('--include-externals');
  a.push('--', ...targets);
  return a;
}

export interface UnversionedEntry {
  path: string;
  item: string;
}

/** Items that "remove unversioned / ignored" may delete, nested ones folded into their folder. */
export function junkEntries<T extends UnversionedEntry>(entries: readonly T[], kinds: { unversioned: boolean; ignored: boolean }): T[] {
  const want = entries.filter((e) => (kinds.unversioned && e.item === 'unversioned') || (kinds.ignored && e.item === 'ignored'));
  return want.filter((e) => !want.some((o) => pathKey(o.path) !== pathKey(e.path) && isSameOrUnder(e.path, o.path)));
}

const unxml = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Entries of `svn status --xml` that hold a lock (local token or, with -u, a server lock). */
export function parseLockedPaths(xml: string): string[] {
  const out: string[] = [];
  const re = /<entry\s+path="([^"]*)"[^>]*>([\s\S]*?)<\/entry>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) if (/<lock>/.test(m[2])) out.push(unxml(m[1]));
  return out;
}

export interface MissingWithMeta {
  path: string;
  size: number;
  hash: string;
}
export interface NewItem {
  path: string;
  size: number;
  hash: string;
}

export interface MovePlan {
  moves: Array<{ from: string; to: string }>;
  deletes: string[];
}

/**
 * Pairs missing versioned files with unversioned files of identical content (moves). A candidate with the
 * same basename wins; unpaired missing items become deletes.
 */
export function pairMoves(missing: readonly MissingWithMeta[], fresh: readonly NewItem[]): MovePlan {
  const pool = [...fresh];
  const moves: MovePlan['moves'] = [];
  const left: MissingWithMeta[] = [];
  const match = (m: MissingWithMeta, sameName: boolean): NewItem | undefined =>
    pool.find((f) => f.size === m.size && f.hash === m.hash && (!sameName || path.basename(f.path).toLowerCase() === path.basename(m.path).toLowerCase()));
  const take = (m: MissingWithMeta, hit: NewItem): void => {
    moves.push({ from: m.path, to: hit.path });
    pool.splice(pool.indexOf(hit), 1);
  };
  for (const m of missing) {
    const hit = match(m, true);
    if (hit) take(m, hit);
    else left.push(m);
  }
  const deletes: string[] = [];
  for (const m of left) {
    const hit = match(m, false);
    if (hit) take(m, hit);
    else deletes.push(m.path);
  }
  return { moves, deletes };
}

/** Default name for "copy": `a.txt` -> `a copy.txt`, `dir` -> `dir copy`. */
export function copyName(name: string): string {
  const ext = path.extname(name);
  return ext && ext !== name ? `${name.slice(0, -ext.length)} copy${ext}` : `${name} copy`;
}

/** Validates a rename / mkdir / copy name typed by the user (relative path allowed). */
export function validateRelativeName(v: string, opts: { allowParent?: boolean } = {}): string | undefined {
  const t = v.trim();
  if (!t) return 'Enter a name.';
  if (/^[a-zA-Z]:/.test(t) || path.isAbsolute(t)) return 'Enter a name or a path relative to the selected item.';
  if (/[<>:"|?*]/.test(t)) return 'The name contains characters that are not allowed on Windows.';
  if (!opts.allowParent && t.split(/[\\/]/).includes('..')) return 'Moving up with ".." is not allowed here; use Move instead.';
  if (/[\\/]$/.test(t)) return 'The name must not end with a slash.';
  return undefined;
}

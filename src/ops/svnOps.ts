import * as fs from 'node:fs';
import * as path from 'node:path';
import { RepoEntry } from '../repos/model';
import { SvnClient, pegSafe } from '../svn/client';
import { SvnError } from '../svn/errors';
import { withTempFile } from '../util/tempFile';
import { formatIgnoreList, mergeIgnore, parseIgnoreList, removeIgnore, MergeResult } from './ignore';
import { dedupeNested, parseCommittedRevision, parseUpdateConflicts, parseUpdatedRevision } from './targets';

export type AddDepth = 'empty' | 'files' | 'immediates' | 'infinity';

export interface TmpCtx extends Ctx {
  /** Folder for property-value and message files (the extension's global storage tmp). */
  tmpDir: string;
}

interface Ctx {
  client: SvnClient;
  repo: RepoEntry;
  signal?: AbortSignal;
}

const opts = (c: Ctx) => ({ repoName: c.repo.name, cwd: c.repo.localFolder, signal: c.signal });

/** `svn add --parents`; --force makes already-versioned paths in a multi-selection a no-op. */
export async function addPaths(c: Ctx, paths: readonly string[], depth: AddDepth = 'infinity'): Promise<void> {
  await c.client.run(['add', '--parents', '--force', '--depth', depth, '--', ...paths.map(pegSafe)], opts(c));
}

export async function isUnversioned(c: Ctx, p: string): Promise<boolean> {
  const r = await c.client.status(p, { repoName: c.repo.name, signal: c.signal });
  const e = r.entries.find((x) => path.resolve(c.repo.localFolder, x.path).toLowerCase() === path.resolve(p).toLowerCase());
  return e?.item === 'unversioned';
}

export async function readIgnore(c: Ctx, dir: string): Promise<string[]> {
  // A folder without the property exits non-zero (W200017); anything else is a real failure.
  try {
    const r = await c.client.run(['propget', 'svn:ignore', '--', pegSafe(dir)], opts(c));
    return parseIgnoreList(r.text);
  } catch (e) {
    if (e instanceof SvnError && /W200017/.test(`${e.message} ${e.stderr}`)) return [];
    throw e;
  }
}

async function writeIgnore(c: TmpCtx, dir: string, entries: string[]): Promise<void> {
  if (entries.length) await withTempFile(c.tmpDir, formatIgnoreList(entries), (f) => c.client.run(['propset', '-F', f, '--encoding', 'UTF-8', '--', 'svn:ignore', pegSafe(dir)], opts(c)));
  else await c.client.run(['propdel', '--', 'svn:ignore', pegSafe(dir)], opts(c));
}

/** propget, merge, propset on the parent folder; returns what changed. */
export async function addIgnore(c: TmpCtx, dir: string, patterns: readonly string[]): Promise<MergeResult> {
  const merged = mergeIgnore(await readIgnore(c, dir), patterns);
  if (merged.added.length) await writeIgnore(c, dir, merged.entries);
  return merged;
}

export async function removeIgnorePatterns(c: TmpCtx, dir: string, patterns: readonly string[]): Promise<string[]> {
  const rest = removeIgnore(await readIgnore(c, dir), patterns);
  await writeIgnore(c, dir, rest);
  return rest;
}

export async function deleteKeepLocal(c: Ctx, p: string): Promise<void> {
  await c.client.run(['delete', '--keep-local', '--force', '--', pegSafe(p)], opts(c));
}

export interface UpdateResult {
  revision?: number;
  conflicts: string[];
}

/** A target that no longer exists locally (incoming add) is updated through its parent folder. */
function updatable(p: string): string {
  return fs.existsSync(p) ? p : path.dirname(p);
}

export async function updatePaths(c: Ctx, paths: readonly string[], o: { force?: boolean } = {}): Promise<UpdateResult> {
  const targets = dedupeNested(paths.map(updatable));
  const r = await c.client.run(['update', ...(o.force ? ['--force', '--accept', 'postpone'] : []), '--', ...targets.map(pegSafe)], opts(c));
  return { revision: parseUpdatedRevision(r.text), conflicts: parseUpdateConflicts(r.text) };
}

export interface OverrideUpdateOptions {
  removeUnversioned: boolean;
  onStep?: (message: string) => void;
}

/** D1/D10: discard local changes (revert -R), optionally delete unversioned files, then update. */
export async function overrideUpdate(c: Ctx, paths: readonly string[], o: OverrideUpdateOptions): Promise<UpdateResult> {
  const targets = dedupeNested(paths);
  if (c.signal?.aborted) throw new SvnError('cancelled', 'Cancelled');
  // From here the flow is not cancellable: stopping between revert and update would leave a half-reverted copy.
  const nc: Ctx = { ...c, signal: undefined };
  o.onStep?.('Reverting local changes');
  const existing = targets.filter((p) => fs.existsSync(p));
  if (existing.length) await nc.client.run(['revert', '-R', '--', ...existing.map(pegSafe)], opts(nc));
  if (o.removeUnversioned) {
    o.onStep?.('Removing unversioned files');
    for (const p of existing) {
      if (fs.statSync(p).isDirectory()) await nc.client.run(['cleanup', '--remove-unversioned', '--', pegSafe(p)], opts(nc));
    }
  }
  o.onStep?.('Updating');
  // --force: a reverted local add that collides with a server add must not abort the update.
  return updatePaths(nc, targets, { force: true });
}

/** Commit message goes through a UTF-8 file (-F), so non-ASCII text and emoji survive the Windows code page. */
export async function commitPaths(c: TmpCtx, paths: readonly string[], message: string): Promise<number | undefined> {
  return withTempFile(c.tmpDir, message, async (file) => {
    const r = await c.client.run(['commit', '--encoding', 'UTF-8', '-F', file, '--', ...dedupeNested(paths).map(pegSafe)], opts(c));
    return parseCommittedRevision(r.text);
  });
}

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { decodeContent, type ContentEncoding } from '../compare/content';
import type { RepoEntry } from '../repos/model';
import { pegSafe, type SvnClient } from '../svn/client';
import { SvnError } from '../svn/errors';
import { assertUnder } from '../util/safePath';
import { withTempFile } from '../util/tempFile';
import { splitConflictMarkers } from './merge';
import { parseConflictInfo, parsePrejProps, versionUrl, type AcceptChoice, type ConflictInfo, type TreeStep } from './model';

export interface ConflictCtx {
  client: Pick<SvnClient, 'run'>;
  repo: RepoEntry;
  signal?: AbortSignal;
}

const o = (c: ConflictCtx) => ({ repoName: c.repo.name, cwd: c.repo.localFolder, signal: c.signal });
const BATCH = 40;

/** `svn info --xml` conflict data for the paths that still have a conflict. */
export async function loadConflictInfo(c: ConflictCtx, paths: readonly string[]): Promise<ConflictInfo[]> {
  const out: ConflictInfo[] = [];
  for (let i = 0; i < paths.length; i += BATCH) {
    const r = await c.client.run(['info', '--', ...paths.slice(i, i + BATCH).map(pegSafe)], { ...o(c), xml: true });
    out.push(...parseConflictInfo(r.text));
  }
  return out;
}

export async function loadOneConflict(c: ConflictCtx, p: string): Promise<ConflictInfo | undefined> {
  const [info] = await loadConflictInfo(c, [p]);
  return info;
}

export interface ResolveOutcome {
  resolved: string[];
  failed: Array<{ path: string; message: string }>;
}

/**
 * `svn resolve --accept <choice>` for each path. A batch runs first; if svn reports a failure (for example an
 * option that does not apply to a tree conflict) the paths are retried one by one so each failure is attributed.
 */
export async function resolvePaths(c: ConflictCtx, paths: readonly string[], accept: AcceptChoice, recursive = false): Promise<ResolveOutcome> {
  const outcome: ResolveOutcome = { resolved: [], failed: [] };
  const args = (ps: readonly string[]): string[] => ['resolve', '--accept', accept, ...(recursive ? ['-R'] : []), '--', ...ps.map(pegSafe)];
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    try {
      await c.client.run(args(batch), o(c));
      outcome.resolved.push(...batch);
    } catch (e) {
      if (!(e instanceof SvnError) || e.kind === 'cancelled') throw e;
      if (batch.length === 1) {
        outcome.failed.push({ path: batch[0], message: explainResolveError(e) });
        continue;
      }
      for (const p of batch) {
        try {
          await c.client.run(args([p]), o(c));
          outcome.resolved.push(p);
        } catch (e2) {
          if (!(e2 instanceof SvnError) || e2.kind === 'cancelled') throw e2;
          outcome.failed.push({ path: p, message: explainResolveError(e2) });
        }
      }
    }
  }
  return outcome;
}

export function explainResolveError(e: SvnError): string {
  if (/W195024|inapplicable/i.test(e.stderr + e.message)) return 'this option does not apply to this kind of conflict (tree conflicts support only "Mark as resolved"; use Resolve Conflict to see the options)';
  return e.message;
}

// ---------- text conflicts ----------

export interface TextInputs {
  base: string;
  mine: string;
  theirs: string;
  /** Encoding of the working file; used when writing the result. */
  encoding: ContentEncoding;
  labels: { base: string; mine: string; theirs: string };
  source: 'conflict-files' | 'markers';
}

async function readDecoded(file: string): Promise<{ text: string; encoding: ContentEncoding; binary: boolean }> {
  const bytes = await fsp.readFile(file);
  return decodeContent(bytes);
}

const exists = (p: string): Promise<boolean> => fsp.access(p).then(() => true, () => false);

export class BinaryConflictError extends Error {
  constructor(file: string) {
    super(`"${path.basename(file)}" is a binary file; use the quick resolve actions (mine / theirs / base) instead of the text editor.`);
    this.name = 'BinaryConflictError';
  }
}

/** Reads base/mine/theirs from the `.mine` / `.rNNN` files svn left next to the file (paths from `svn info`). */
export async function loadTextInputs(info: ConflictInfo): Promise<TextInputs> {
  const t = info.text;
  if (!t) throw new Error('This file has no text conflict.');
  const rev = (v: { revision?: number } | undefined): string => (v?.revision !== undefined ? ` r${v.revision}` : '');
  const labels = {
    base: `Base (common ancestor${rev(info.left)})`,
    mine: 'Mine (working copy before the update)',
    theirs: `Theirs (incoming${rev(info.right)})`,
  };
  const files = [t.baseFile, t.mineFile, t.theirsFile];
  if (files.every((f): f is string => !!f) && (await Promise.all(files.map((f) => exists(f as string)))).every(Boolean)) {
    const [b, m, th] = await Promise.all(files.map((f) => readDecoded(f as string)));
    if (b.binary || m.binary || th.binary) throw new BinaryConflictError(info.path);
    return { base: b.text, mine: m.text, theirs: th.text, encoding: m.encoding, labels, source: 'conflict-files' };
  }
  const work = await readDecoded(info.path);
  if (work.binary) throw new BinaryConflictError(info.path);
  const parts = splitConflictMarkers(work.text);
  if (!parts) {
    throw new Error(`The conflict files of "${path.basename(info.path)}" (.mine, .rNNN) are gone and the file has no conflict markers. Use the quick resolve actions, or Revert and update again.`);
  }
  return { ...parts, encoding: work.encoding, labels: { ...labels, mine: 'Mine (rebuilt from the conflict markers)', theirs: 'Theirs (rebuilt from the conflict markers)' }, source: 'markers' };
}

// ---------- property conflicts ----------

export interface PropertyValues {
  name: string;
  /** undefined: the property does not exist on that side. */
  base?: string;
  mine?: string;
  theirs?: string;
}

async function propget(c: ConflictCtx, name: string, target: string): Promise<string | undefined> {
  try {
    const r = await c.client.run(['propget', '--strict', '--', name, pegSafe(target)], o(c));
    return decodeContent(r.stdout).text;
  } catch (e) {
    if (e instanceof SvnError && /W200017|E200017|not found/i.test(e.stderr + e.message)) return undefined;
    throw e;
  }
}

export async function readPrej(info: ConflictInfo): Promise<string> {
  const f = info.property?.prejFile;
  if (!f || !(await exists(f))) return '';
  return (await readDecoded(f)).text;
}

/** Properties named by the `.prej`; falls back to every property of the working node when it cannot be parsed. */
export async function conflictedProperties(c: ConflictCtx, info: ConflictInfo, prej: string): Promise<string[]> {
  const names = parsePrejProps(prej);
  if (names.length) return names;
  const r = await c.client.run(['proplist', '-q', '--', pegSafe(info.path)], o(c));
  return r.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * Mine = the working value (svn keeps the local value on a property conflict), base = value at the source-left
 * revision, theirs = value at the source-right revision (both read from the repository).
 */
export async function readPropertyValues(c: ConflictCtx, info: ConflictInfo, name: string): Promise<PropertyValues> {
  const mine = await propget(c, name, info.path);
  const base = info.left ? await propget(c, name, versionUrl(info.left)) : undefined;
  const theirs = info.right ? await propget(c, name, versionUrl(info.right)) : undefined;
  return { name, base, mine, theirs };
}

/** Sets (or, for `undefined`, deletes) a property. */
export async function applyProperty(c: ConflictCtx & { tmpDir: string }, p: string, name: string, value: string | undefined): Promise<void> {
  if (value === undefined) await c.client.run(['propdel', '--', name, pegSafe(p)], o(c));
  else await withTempFile(c.tmpDir, value, (f) => c.client.run(['propset', '-F', f, ...(name.startsWith('svn:') ? ['--encoding', 'UTF-8'] : []), '--', name, pegSafe(p)], o(c)));
}

// ---------- tree conflicts ----------

export async function runTreeSteps(c: ConflictCtx, p: string, steps: readonly TreeStep[], isDir: boolean): Promise<void> {
  for (const s of steps) {
    switch (s.op) {
      case 'resolve':
        await c.client.run(['resolve', '--accept', s.accept, '--', pegSafe(p)], o(c));
        break;
      case 'revert':
        await c.client.run(['revert', ...(isDir ? ['-R'] : []), '--', pegSafe(p)], o(c));
        break;
      case 'deleteForce':
        await c.client.run(['delete', '--force', '--', pegSafe(p)], o(c));
        break;
      case 'removeFromDisk':
        await fsp.rm(assertUnder(path.resolve(c.repo.localFolder, p), c.repo.localFolder), { recursive: true, force: true });
        break;
      case 'update':
        await c.client.run(['update', '--', pegSafe(p)], o(c));
        break;
    }
  }
}

import type { RepoEntry } from '../repos/model';
import type { SvnClient } from '../svn/client';
import { pegSafe } from '../svn/client';
import { SvnError } from '../svn/errors';
import { LogEntry, parseLog } from '../svn/xml';
import { MergeResult, MergeSpec, buildMergeArgs, parseMergeOutput, parseRevList } from './model';

export interface MergeCtx {
  client: SvnClient;
  repo: RepoEntry;
  signal?: AbortSignal;
  /** Working directory for svn; merge output paths are relative to it. Default: the repo's working copy root. */
  cwd?: string;
}

const o = (c: MergeCtx) => ({ repoName: c.repo.name, cwd: c.cwd ?? c.repo.localFolder, signal: c.signal, timeoutMs: 30 * 60_000 });

export async function runMerge(c: MergeCtx, spec: MergeSpec): Promise<MergeResult & { text: string }> {
  const r = await c.client.run(buildMergeArgs(spec), o(c));
  return { ...parseMergeOutput(r.text), text: r.text };
}

/** Revisions of `source` that are (`merged`) or are not yet (`eligible`) merged into `target`. */
export async function mergeinfoRevs(c: MergeCtx, which: 'merged' | 'eligible', source: string, target: string): Promise<number[]> {
  const r = await c.client.run(['mergeinfo', '--show-revs', which, '--', pegSafe(source), pegSafe(target)], o(c));
  return parseRevList(r.text);
}

/** Log entries (with messages) of the source for the given revisions. */
export async function logOfRevs(c: MergeCtx, source: string, revs: readonly number[]): Promise<LogEntry[]> {
  if (!revs.length) return [];
  const lo = Math.min(...revs);
  const hi = Math.max(...revs);
  const r = await c.client.run(['log', '-r', `${hi}:${lo}`, '--', pegSafe(source)], { ...o(c), xml: true });
  const want = new Set(revs);
  return parseLog(r.text).filter((e) => want.has(e.revision));
}

/** Count of locally changed items (modified/added/deleted/conflicted ...) under the target. */
export async function localChangeCount(c: MergeCtx, target: string): Promise<number> {
  const s = await c.client.status(target, { repoName: c.repo.name, cwd: c.repo.localFolder, signal: c.signal });
  return s.entries.filter((e) => !['unversioned', 'ignored', 'normal', 'none', 'external'].includes(e.item) || (e.props !== 'none' && e.props !== 'normal' && e.props !== '')).length;
}

export class MixedRevisionError extends Error {}

/** Friendlier message for the svn errors a merge commonly hits. */
export function explainMergeError(e: unknown): Error | undefined {
  if (!(e instanceof SvnError)) return undefined;
  const t = `${e.message} ${e.stderr}`;
  if (/E195020|mixed-revision/i.test(t)) return new MixedRevisionError('The working copy has mixed revisions. Update it to HEAD first, then merge again.');
  if (/E195016|reintegrate/i.test(t) && /switched|modif|mixed|subtree/i.test(t)) return new Error(`Merge refused: ${e.stderr.split(/\r?\n/).find((l) => /E195016|svn:/.test(l)) ?? e.message}`);
  if (/E195012|no common ancestry|unrelated/i.test(t)) return new Error('The source and the working copy are unrelated (no common ancestry). Use "Ignore ancestry" only if that is intended.');
  return undefined;
}

/** `svn update` of the merge target (plain, conflicts postponed); used to fix a mixed-revision working copy. */
export async function updateTarget(c: MergeCtx, target: string): Promise<void> {
  await c.client.run(['update', '--accept', 'postpone', '--', pegSafe(target)], o(c));
}

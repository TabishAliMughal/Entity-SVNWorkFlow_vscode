import { parseUpdateConflicts } from '../ops/targets';
import { SvnClient, SvnRunOptions, pegSafe } from '../svn/client';
import { SvnError } from '../svn/errors';
import { LogEntry, parseInfo, parseLog } from '../svn/xml';
import { FetchBatch, LogFilter, buildLogArgs, repoPathToUrl } from './model';

export interface HistoryTarget {
  repoName: string;
  /** Working-copy file, folder or repo root. */
  fsPath: string;
  cwd: string;
}

export interface TargetInfo {
  url: string;
  root: string;
  kind: string;
  /** Working-copy revision of the target. */
  revision: number;
}

export async function targetInfo(client: SvnClient, t: HistoryTarget, signal?: AbortSignal): Promise<TargetInfo> {
  const i = parseInfo((await client.run(['info', '--', pegSafe(t.fsPath)], { repoName: t.repoName, cwd: t.cwd, xml: true, signal })).text);
  return { url: i.url, root: i.repositoryRoot, kind: i.nodeKind, revision: i.revision };
}

/** Batch fetcher for `loadPage`; `target` is the WC path (or URL). */
export function logBatchFetcher(client: SvnClient, t: HistoryTarget, f: LogFilter, signal?: AbortSignal): FetchBatch {
  return async (cursor, limit) => {
    const args = buildLogArgs(pegSafe(t.fsPath), f, limit, cursor);
    try {
      const r = await client.run(args, { repoName: t.repoName, cwd: t.cwd, xml: true, signal });
      return parseLog(r.text);
    } catch (e) {
      // The path does not exist yet at the newest bound (range lies before its creation): no entries.
      if (e instanceof SvnError && (e.codes.includes('E195012') || /E195012/.test(e.message))) return [];
      throw e;
    }
  };
}

/** Content of a repository path at a revision; '' when it does not exist there (e.g. before an add). */
export async function catAtRevision(client: SvnClient, repoName: string, root: string, repoPath: string, rev: number, cwd?: string, signal?: AbortSignal): Promise<string> {
  const url = `${repoPathToUrl(root, repoPath)}@${rev}`;
  const opts: SvnRunOptions = { repoName, cwd, signal };
  const r = await client.run(['cat', '-r', String(rev), '--', url], opts);
  return r.text;
}

export interface LeftRight {
  leftPath?: string;
  leftRev?: number;
  rightPath?: string;
  rightRev?: number;
}

/** Which repository content shows the change of `path` in `entry`: rev-1 (or the copy source) vs rev, absent side = empty. */
export function sidesForChange(entry: LogEntry, repoPath: string): LeftRight {
  const p = entry.paths.find((x) => x.path === repoPath);
  const action = p?.action ?? 'M';
  const out: LeftRight = {};
  if (action !== 'D') {
    out.rightPath = repoPath;
    out.rightRev = entry.revision;
  }
  if (action === 'M' || action === 'R') {
    out.leftPath = repoPath;
    out.leftRev = entry.revision - 1;
  } else if (action === 'D') {
    out.leftPath = repoPath;
    out.leftRev = entry.revision - 1;
  } else if (action === 'A' && p?.copyfromPath && p.copyfromRev !== undefined) {
    out.leftPath = p.copyfromPath;
    out.leftRev = p.copyfromRev;
  }
  return out;
}

export interface MergeOutcome {
  text: string;
  conflicts: string[];
}

/** Update the path to a revision (`svn update -r`); leaves conflicts for the user (postpone). */
export async function updateToRevision(client: SvnClient, t: HistoryTarget, rev: number, signal?: AbortSignal): Promise<MergeOutcome> {
  const r = await client.run(['update', '-r', String(rev), '--accept', 'postpone', '--', pegSafe(t.fsPath)], { repoName: t.repoName, cwd: t.cwd, signal });
  return { text: r.text, conflicts: parseUpdateConflicts(r.text) };
}

/** Undo only what revision REV changed (reverse merge `-c -REV`) in the working copy. */
export async function revertChangesOfRevision(client: SvnClient, t: HistoryTarget, rev: number, signal?: AbortSignal): Promise<MergeOutcome> {
  const r = await client.run(['merge', '-c', `-${rev}`, '--accept', 'postpone', '--', pegSafe(t.fsPath)], { repoName: t.repoName, cwd: t.cwd, signal });
  return { text: r.text, conflicts: parseUpdateConflicts(r.text) };
}

/** Make the path look like it did at REV: reverse merge `-r HEAD:REV`, i.e. undo REV+1..HEAD. */
export async function revertToRevision(client: SvnClient, t: HistoryTarget, rev: number, signal?: AbortSignal): Promise<MergeOutcome> {
  const r = await client.run(['merge', '-r', `HEAD:${rev}`, '--accept', 'postpone', '--', pegSafe(t.fsPath)], { repoName: t.repoName, cwd: t.cwd, signal });
  return { text: r.text, conflicts: parseUpdateConflicts(r.text) };
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import { addPaths } from '../ops/svnOps';
import { parseCommittedRevision } from '../ops/targets';
import { RepoEntry } from '../repos/model';
import { SvnClient, pegSafe } from '../svn/client';
import { withTempFile } from '../util/tempFile';
import { withTargetArgs } from '../util/targets';
import { CommitPlan } from './selection';

interface Ctx {
  client: SvnClient;
  repo: RepoEntry;
  signal?: AbortSignal;
}

export interface CommitOptions {
  message: string;
  /** Directory for the message/targets temp files (deleted afterwards). */
  tmpDir: string;
  keepLocks?: boolean;
  keepChangelists?: boolean;
}

const opts = (c: Ctx) => ({ repoName: c.repo.name, cwd: c.repo.localFolder, signal: c.signal });

function commonArgs(o: CommitOptions, msgFile: string): string[] {
  const a = ['commit', '--encoding', 'UTF-8', '-F', msgFile];
  if (o.keepLocks) a.push('--no-unlock');
  if (o.keepChangelists) a.push('--keep-changelists');
  return a;
}

/** Paths that `svn add` of a folder brought in; they are separate commit targets because of `--depth empty`. */
async function addedUnder(c: Ctx, dir: string): Promise<string[]> {
  const r = await c.client.status(dir, { repoName: c.repo.name, signal: c.signal });
  return r.entries.filter((e) => e.item === 'added').map((e) => path.resolve(c.repo.localFolder, e.path));
}

/**
 * Adds the checked unversioned items, then commits exactly the selected paths. `--depth empty` makes svn commit each
 * explicit target only (a checked folder does not drag in unchecked children); content of freshly added folders is
 * listed explicitly. Message and targets go through temp files so nothing user-supplied reaches the command line.
 */
export async function executeCommit(c: Ctx, plan: CommitPlan, o: CommitOptions): Promise<{ revision?: number; targets: string[] }> {
  if (plan.add.length) await addPaths(c, plan.add, 'infinity');
  const targets = new Map<string, string>();
  const put = (p: string): void => void targets.set(path.resolve(p).toLowerCase(), p);
  plan.commit.forEach(put);
  for (const p of plan.add) {
    put(p);
    let isDir = false;
    try {
      isDir = fs.statSync(p).isDirectory();
    } catch {
      /* gone */
    }
    if (isDir) for (const a of await addedUnder(c, p)) put(a);
  }
  const list = [...targets.values()];
  const r = await withTempFile(o.tmpDir, o.message.trim(), (msgFile) =>
    withTargetArgs(o.tmpDir, list.map(pegSafe), (tail) => c.client.run([...commonArgs(o, msgFile), '--depth', 'empty', ...tail], opts(c))),
  );
  return { revision: parseCommittedRevision(r.text), targets: list };
}

/** `svn commit --changelist NAME` of the whole working copy. */
export async function commitChangelist(c: Ctx, name: string, o: CommitOptions): Promise<number | undefined> {
  const r = await withTempFile(o.tmpDir, o.message.trim(), (msgFile) => c.client.run([...commonArgs(o, msgFile), '--changelist', name, '--', pegSafe(c.repo.localFolder)], opts(c)));
  return parseCommittedRevision(r.text);
}

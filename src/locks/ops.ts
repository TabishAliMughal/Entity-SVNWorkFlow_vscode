import * as fs from 'node:fs';
import { RepoEntry } from '../repos/model';
import { SvnClient, pegSafe } from '../svn/client';
import { SvnError } from '../svn/errors';
import { parseStatus } from '../svn/xml';
import { withTempFile } from '../util/tempFile';
import { LockView, lockView } from './model';

interface Ctx {
  client: SvnClient;
  repo: RepoEntry;
  signal?: AbortSignal;
}
const opts = (c: Ctx) => ({ repoName: c.repo.name, cwd: c.repo.localFolder, signal: c.signal });

/** `svn lock -F <file>` (UTF-8, multi-line safe); force steals a lock somebody else holds. */
export async function lockPaths(c: Ctx & { tmpDir: string }, paths: readonly string[], comment: string, force = false): Promise<void> {
  const run = (extra: string[]): Promise<unknown> => c.client.run(['lock', ...extra, ...(force ? ['--force'] : []), '--', ...paths.map(pegSafe)], opts(c));
  if (comment) await withTempFile(c.tmpDir, comment, (f) => run(['-F', f, '--encoding', 'UTF-8']));
  else await run([]);
}

/**
 * `svn unlock`. With force the lock is broken through the file's URL: a working-copy path would present our
 * (possibly stale) token, and the server then answers "no lock" instead of removing somebody else's lock.
 * Afterwards the local token is dropped so the working copy stops reporting a stale lock.
 */
export async function unlockPaths(c: Ctx, paths: readonly string[], force = false): Promise<void> {
  if (!force) {
    await c.client.run(['unlock', '--', ...paths.map(pegSafe)], opts(c));
    return;
  }
  const urls: string[] = [];
  for (const p of paths) urls.push((await c.client.info(p, opts(c))).url);
  // W160040 / W170007 "no lock": somebody already released it; still fall through to drop our stale token.
  const r = await c.client.run(['unlock', '--force', '--', ...urls], { ...opts(c), allowFailure: true });
  if (r.exitCode !== 0 && !/W160040|W170007/.test(r.stderr)) throw new SvnError('unknown', r.stderr.trim().split(/\r?\n/)[0] || 'svn unlock failed', r.exitCode, r.stderr);
  await c.client.run(['unlock', '--', ...paths.map(pegSafe)], { ...opts(c), allowFailure: true });
}

/** Lock state of one path from one `status -u` call (contacts the server). */
export async function lockOf(c: Ctx, p: string): Promise<LockView> {
  const r = await c.client.run(['status', '--show-updates', '--', pegSafe(p)], { ...opts(c), xml: true });
  const e = parseStatus(r.text).entries[0];
  return lockView(e?.lock, e?.repoLock, true);
}

export interface LockedFile {
  path: string;
  view: LockView;
}

/** Every locked file under the repo (my locks and other people's) via `status -u`. */
export async function listLocks(c: Ctx): Promise<LockedFile[]> {
  const r = await c.client.run(['status', '--show-updates', '--', pegSafe(c.repo.localFolder)], { ...opts(c), xml: true });
  const out: LockedFile[] = [];
  for (const e of parseStatus(r.text).entries) {
    const v = lockView(e.lock, e.repoLock, true);
    if (v.state !== 'none') out.push({ path: e.path, view: v });
  }
  return out;
}

/** True when `svn:needs-lock` is set on the file (a missing property is not an error). */
export async function hasNeedsLock(c: Ctx, p: string): Promise<boolean> {
  try {
    const r = await c.client.run(['propget', 'svn:needs-lock', '--', pegSafe(p)], opts(c));
    return r.text.trim() !== '';
  } catch (e) {
    if (e instanceof SvnError && (/W200017/.test(`${e.message} ${e.stderr}`) || e.kind === 'notWorkingCopy')) return false;
    throw e;
  }
}

/** svn makes needs-lock files read-only; on Windows that is the read-only attribute. */
export function isReadOnlyOnDisk(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return false;
  } catch {
    return true;
  }
}


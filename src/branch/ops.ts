import { parseList } from '../svn/list';
import type { RepoEntry } from '../repos/model';
import type { SvnClient } from '../svn/client';
import { SvnError } from '../svn/errors';
import { withTempFile } from '../util/tempFile';
import { CopySource, buildCopyArgs, parseCommitted } from './model';

export interface BranchCtx {
  client: SvnClient;
  repo: RepoEntry;
  signal?: AbortSignal;
  /** Folder for the -F message files. */
  tmpDir: string;
}

const o = (c: BranchCtx) => ({ repoName: c.repo.name, cwd: c.repo.localFolder, signal: c.signal });

/** `svn copy` to a URL (immediate commit). WC sources include local modifications. */
export async function createRef(c: BranchCtx, src: CopySource, destUrl: string, message: string): Promise<{ revision?: number }> {
  const r = await withTempFile(c.tmpDir, message.trim(), (f) => c.client.run(buildCopyArgs(src, destUrl, f), o(c)));
  return { revision: parseCommitted(r.text) };
}

/** Server-side `svn delete URL`. */
export async function deleteUrl(c: BranchCtx, url: string, message: string): Promise<{ revision?: number }> {
  const r = await withTempFile(c.tmpDir, message.trim(), (f) => c.client.run(['delete', '-F', f, '--encoding', 'UTF-8', '--', url], o(c)));
  return { revision: parseCommitted(r.text) };
}

const MISSING = /E170000|E160013|E200009|doesn't exist|non-existent|not found/i;

/** Child folder names of a URL; [] when the URL does not exist. */
export async function listDirs(c: BranchCtx | Pick<BranchCtx, 'client' | 'repo' | 'signal'>, url: string): Promise<string[]> {
  try {
    // --xml: the plain listing is in the console code page and mangles non-ASCII names; XML is always UTF-8
    const r = await c.client.run(['list', '--', url], { ...o(c as BranchCtx), xml: true });
    return parseList(r.text).filter((e) => e.kind === 'dir').map((e) => e.name);
  } catch (e) {
    if (e instanceof SvnError && MISSING.test(`${e.message} ${e.stderr}`)) return [];
    throw e;
  }
}

export async function urlExists(c: Pick<BranchCtx, 'client' | 'repo' | 'signal'>, url: string): Promise<boolean> {
  try {
    await c.client.run(['info', '--depth', 'empty', '--', url], o(c as BranchCtx));
    return true;
  } catch (e) {
    if (e instanceof SvnError && MISSING.test(`${e.message} ${e.stderr}`)) return false;
    throw e;
  }
}

import { access } from 'node:fs/promises';
import * as path from 'node:path';
import type { SvnClient } from '../svn/client';
import { pegSafe } from '../svn/client';
import { SvnError } from '../svn/errors';
import { decodeContent, type DecodedContent } from './content';

export type Rev = 'HEAD' | 'BASE' | number;

export interface FetchTarget {
  repoName: string;
  /** Local path, or an svn URL. */
  target: string;
  rev: Rev;
}

export interface Fetched extends DecodedContent {
  /** The path does not exist at that revision (e.g. deleted on the server): treated as empty text. */
  missing: boolean;
  mime?: string;
}

type ClientLike = Pick<SvnClient, 'run' | 'info'>;

const NOT_FOUND = /E160013|E170000|E200009|E195012|path not found|doesn't exist|does not exist|non-existent|not found in revision/i;

export function isNotFound(e: unknown): boolean {
  return e instanceof SvnError && e.kind !== 'offline' && e.kind !== 'auth' && e.kind !== 'certificate' && (e.codes.some((c) => NOT_FOUND.test(c)) || NOT_FOUND.test(e.stderr) || NOT_FOUND.test(e.message));
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The thing to `svn cat`: the local path when it exists (peg handles renames), otherwise the URL
 * of the nearest versioned ancestor plus the relative path (remote-added files have no local copy).
 */
export async function resolveCatTarget(client: ClientLike, repoName: string, fsPath: string, stopAt?: string): Promise<string> {
  if (await exists(fsPath)) return fsPath;
  const rel: string[] = [];
  let dir = fsPath;
  for (;;) {
    const parent = path.dirname(dir);
    rel.unshift(path.basename(dir));
    if (parent === dir || (stopAt && dir.toLowerCase() === stopAt.toLowerCase())) throw new Error(`No versioned parent folder found for ${fsPath}`);
    dir = parent;
    if (await exists(dir)) break;
  }
  const info = await client.info(dir, { repoName });
  return `${info.url.replace(/\/+$/, '')}/${rel.map(encodeURIComponent).join('/')}`;
}

/** `svn cat -r <rev>` plus `svn:mime-type`, decoded. A missing path yields `missing: true`. */
export async function fetchContent(client: ClientLike, t: FetchTarget, signal?: AbortSignal): Promise<Fetched> {
  const rev = String(t.rev);
  const target = pegSafe(t.target);
  const opts = { repoName: t.repoName, signal };
  const [cat, mime] = await Promise.allSettled([
    client.run(['cat', '-r', rev, '--', target], opts),
    client.run(['propget', 'svn:mime-type', '-r', rev, '--', target], opts),
  ]);
  if (cat.status === 'rejected') {
    if (isNotFound(cat.reason)) return { text: '', encoding: 'utf-8', binary: false, missing: true };
    throw cat.reason;
  }
  const mimeText = mime.status === 'fulfilled' ? mime.value.text.trim() || undefined : undefined;
  return { ...decodeContent(cat.value.stdout, mimeText), missing: false, mime: mimeText };
}

import * as path from 'node:path';
import { RepoEntry } from './model';

export interface ResolveOptions {
  /** Defaults to true on Windows. */
  caseInsensitive?: boolean;
  /** Path flavour; defaults to the host platform's. */
  platform?: 'win32' | 'posix';
}

function flavour(opts: ResolveOptions): { p: path.PlatformPath; ci: boolean } {
  const platform = opts.platform ?? (process.platform === 'win32' ? 'win32' : 'posix');
  return { p: platform === 'win32' ? path.win32 : path.posix, ci: opts.caseInsensitive ?? platform === 'win32' };
}

export function normalizePath(input: string, opts: ResolveOptions = {}): string {
  const { p, ci } = flavour(opts);
  let n = p.normalize(input);
  const root = p.parse(n).root;
  while (n.length > root.length && /[\\/]$/.test(n)) n = n.slice(0, -1);
  return ci ? n.toLowerCase() : n;
}

/** Longest-prefix match of a file/folder path against repo local folders. */
export function resolveRepo(filePath: string, repos: readonly RepoEntry[], opts: ResolveOptions = {}): RepoEntry | undefined {
  const { p } = flavour(opts);
  if (!filePath || !p.isAbsolute(filePath)) return undefined;
  const target = normalizePath(filePath, opts);
  let best: RepoEntry | undefined;
  let bestLen = -1;
  for (const repo of repos) {
    if (!repo.localFolder) continue;
    const root = normalizePath(repo.localFolder, opts);
    const sep = p.sep;
    const isPrefix = target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
    if (isPrefix && root.length > bestLen) {
      best = repo;
      bestLen = root.length;
    }
  }
  return best;
}

export class NoRepoError extends Error {
  constructor(public readonly filePath: string) {
    super(
      `"${filePath}" is not inside the current SVN working copy. ` +
        'The extension works on the working copy that contains the opened folder.',
    );
    this.name = 'NoRepoError';
  }
}

export class RepoResolver {
  constructor(private readonly getRepos: () => readonly RepoEntry[], private readonly opts: ResolveOptions = {}) {}

  resolve(filePath: string): RepoEntry | undefined {
    return resolveRepo(filePath, this.getRepos(), this.opts);
  }

  /** Like resolve(), but throws NoRepoError. */
  require(filePath: string): RepoEntry {
    const r = this.resolve(filePath);
    if (!r) throw new NoRepoError(filePath);
    return r;
  }
}

import { SvnClient, pegSafe } from '../svn/client';
import { parseBlame, parseInfo, parseLog } from '../svn/xml';
import { BlameCache, BlameData } from './model';

export interface BlameTarget {
  repoName: string;
  fsPath: string;
  cwd?: string;
}

export interface BlameOptions {
  ignoreWhitespace?: boolean;
  signal?: AbortSignal;
}

/** Blame of the file as of BASE, cached by file + last-changed revision (so update/commit naturally miss). */
export async function loadBlame(client: SvnClient, cache: BlameCache, t: BlameTarget, opts: BlameOptions = {}): Promise<BlameData> {
  const info = parseInfo((await client.run(['info', '--', pegSafe(t.fsPath)], { repoName: t.repoName, cwd: t.cwd, xml: true, signal: opts.signal })).text);
  const revision = info.lastChangedRevision ?? info.revision;
  // -x -w changes the blame result, so it is part of the cache identity.
  const keyPath = opts.ignoreWhitespace ? `${t.fsPath}\u0000w` : t.fsPath;
  return cache.getOrLoad(keyPath, revision, async () => {
    const args = ['blame', '-r', 'BASE'];
    if (opts.ignoreWhitespace) args.push('-x', '-w');
    args.push('--', pegSafe(t.fsPath));
    const [blame, cat] = await Promise.all([
      client.run(args, { repoName: t.repoName, cwd: t.cwd, xml: true, signal: opts.signal }),
      client.run(['cat', '-r', 'BASE', '--', pegSafe(t.fsPath)], { repoName: t.repoName, cwd: t.cwd, signal: opts.signal }),
    ]);
    return { revision, lines: parseBlame(blame.text), baseText: cat.text };
  });
}

/** Commit messages by revision, fetched lazily (one `svn log -r REV` against the repository root) and remembered. */
export class MessageCache {
  private readonly map = new Map<string, Promise<string | undefined>>();
  private readonly roots = new Map<string, Promise<string>>();

  constructor(private readonly client: SvnClient) {}

  private root(repoName: string, fsPath: string, cwd?: string): Promise<string> {
    let p = this.roots.get(repoName);
    if (!p) {
      p = this.client.info(fsPath, { repoName, cwd }).then((i) => i.repositoryRoot);
      p.catch(() => this.roots.delete(repoName));
      this.roots.set(repoName, p);
    }
    return p;
  }

  get(repoName: string, fsPath: string, revision: number, cwd?: string): Promise<string | undefined> {
    const k = `${repoName}:${revision}`;
    let p = this.map.get(k);
    if (!p) {
      p = this.root(repoName, fsPath, cwd)
        .then((root) => this.client.run(['log', '-r', String(revision), '--', root], { repoName, cwd, xml: true }))
        .then((r) => parseLog(r.text)[0]?.message)
        .catch(() => {
          this.map.delete(k);
          return undefined;
        });
      this.map.set(k, p);
    }
    return p;
  }
}

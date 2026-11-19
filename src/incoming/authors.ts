import * as path from 'node:path';
import { RepoEntry } from '../repos/model';
import { pegSafe } from '../svn/client';
import { LogEntry, SvnInfo, parseInfoAll, parseLog } from '../svn/xml';
import { Logger, nullLogger } from '../util/logger';
import { ChangeItem, authorCacheable, pathKey } from './model';

export interface AuthorSource {
  run(args: readonly string[], opts: { repoName?: string; xml?: boolean; signal?: AbortSignal }): Promise<{ text: string }>;
  info(target: string, opts: { repoName?: string }): Promise<SvnInfo>;
}

const INFO_BATCH = 25;
const LOG_LIMIT = 500;
const FALLBACK_CAP = 20;
const FALLBACK_CONCURRENCY = 4;

/** Newest log entry touching `itemPath` (exactly, or via a replaced/deleted parent). Entries are newest first. */
export function newestEntryFor(itemPath: string, log: readonly LogEntry[]): LogEntry | undefined {
  return log.find((le) => le.paths.some((p) => p.path === itemPath || itemPath.startsWith(p.path + '/')));
}

export function newestAuthorFor(itemPath: string, log: readonly LogEntry[]): string | undefined {
  return newestEntryFor(itemPath, log)?.author;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** svn ISO date -> `YYYY-MM-DD HH:mm:ss` in local time; undefined when unparsable. */
export function formatCommitDate(iso: string | undefined): string | undefined {
  const d = iso ? new Date(iso) : undefined;
  if (!d || Number.isNaN(d.getTime())) return undefined;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export interface CommitStamp {
  author: string;
  /** ISO date from svn. */
  date?: string;
}

/** Repository-root-relative path of a local item, given the working copy root URL and root path. */
export function repoPathOf(item: string, wcRoot: string, wcUrl: string, repoRoot: string): string {
  const base = decodeURIComponent(wcUrl.slice(repoRoot.length)).replace(/\/$/, '');
  const rel = path.relative(wcRoot, item).split(path.sep).filter(Boolean).join('/');
  return rel ? `${base}/${rel}` : base || '/';
}

export function authorLabel(author: string | undefined): string | undefined {
  return author && author.length ? author : undefined;
}

/** Batched, cached last-committer lookups. Results are read with get(); lookup() fills the cache. */
export class AuthorResolver {
  private readonly cache = new Map<string, CommitStamp | null>();

  constructor(private readonly client: AuthorSource, private readonly logger: Logger = nullLogger) {}

  private key(item: ChangeItem, youngest: number | undefined): string {
    return item.incoming
      ? `${item.repoName}|in|${pathKey(item.path)}|${youngest ?? ''}|${item.revision ?? ''}`
      : `${item.repoName}|base|${pathKey(item.path)}|${item.revision ?? ''}`;
  }

  /** Cached author, if looked up. */
  get(item: ChangeItem, youngest: number | undefined): string | undefined {
    return this.getStamp(item, youngest)?.author;
  }

  getStamp(item: ChangeItem, youngest: number | undefined): CommitStamp | undefined {
    return this.cache.get(this.key(item, youngest)) ?? undefined;
  }

  has(item: ChangeItem, youngest: number | undefined): boolean {
    return this.cache.has(this.key(item, youngest));
  }

  clear(): void {
    this.cache.clear();
  }

  /** Looks up authors for items not yet cached. Returns true if the cache gained entries. */
  async lookup(repo: RepoEntry, items: readonly ChangeItem[], youngest: number | undefined, signal?: AbortSignal): Promise<boolean> {
    const todo = items.filter((i) => !this.has(i, youngest));
    if (!todo.length) return false;
    const incoming = todo.filter((i) => i.incoming);
    const base = todo.filter((i) => !i.incoming && authorCacheable(i));
    for (const i of todo) if (!i.incoming && !authorCacheable(i)) this.cache.set(this.key(i, youngest), null);
    await Promise.all([this.lookupIncoming(repo, incoming, youngest, signal), this.lookupBase(repo, base, youngest, signal)]);
    return true;
  }

  private async lookupBase(repo: RepoEntry, items: ChangeItem[], youngest: number | undefined, signal?: AbortSignal): Promise<void> {
    for (let i = 0; i < items.length; i += INFO_BATCH) {
      const batch = items.slice(i, i + INFO_BATCH);
      try {
        const r = await this.client.run(['info', '--', ...batch.map((b) => pegSafe(b.path))], { repoName: repo.name, xml: true, signal });
        const byKey = new Map(parseInfoAll(r.text).map((inf) => [pathKey(path.resolve(repo.localFolder, inf.path)), inf]));
        for (const it of batch) {
          const inf = byKey.get(pathKey(it.path));
          const author = authorLabel(inf?.lastChangedAuthor);
          this.cache.set(this.key(it, youngest), author ? { author, date: inf?.lastChangedDate } : null);
        }
      } catch (e) {
        if (signal?.aborted) return;
        this.logger.warn(`Author lookup (info) failed for "${repo.name}": ${(e as Error).message}`);
        for (const it of batch) this.cache.set(this.key(it, youngest), null);
      }
    }
  }

  private async lookupIncoming(repo: RepoEntry, items: ChangeItem[], youngest: number | undefined, signal?: AbortSignal): Promise<void> {
    if (!items.length) return;
    const found = new Map<ChangeItem, LogEntry | undefined>();
    try {
      const wc = await this.client.info(repo.localFolder, { repoName: repo.name });
      const minRev = Math.min(wc.revision, ...items.map((i) => i.revision ?? wc.revision));
      const r = await this.client.run(['log', '-v', '-r', `HEAD:${minRev + 1}`, '--limit', String(LOG_LIMIT), '--', pegSafe(repo.localFolder)], { repoName: repo.name, xml: true, signal });
      const log = parseLog(r.text);
      for (const it of items) found.set(it, newestEntryFor(repoPathOf(it.path, repo.localFolder, wc.url, wc.repositoryRoot), log));
    } catch (e) {
      if (signal?.aborted) return;
      this.logger.warn(`Author lookup (log) failed for "${repo.name}": ${(e as Error).message}`);
    }
    // Items the batch log did not cover (limit hit, remote-added file): ask per file, capped.
    const missing = items.filter((i) => !authorLabel(found.get(i)?.author)).slice(0, FALLBACK_CAP);
    for (let i = 0; i < missing.length; i += FALLBACK_CONCURRENCY) {
      await Promise.all(
        missing.slice(i, i + FALLBACK_CONCURRENCY).map(async (it) => {
          try {
            const r = await this.client.run(['log', '-l', '1', '-r', `HEAD:${it.revision ?? 1}`, '--', pegSafe(it.path)], { repoName: repo.name, xml: true, signal });
            found.set(it, parseLog(r.text)[0]);
          } catch {
            /* remote-added or deleted items have no local path to query */
          }
        }),
      );
    }
    for (const it of items) {
      const e = found.get(it);
      const author = authorLabel(e?.author);
      this.cache.set(this.key(it, youngest), author ? { author, date: e?.date } : null);
    }
  }
}

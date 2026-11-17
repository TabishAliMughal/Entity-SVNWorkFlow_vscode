import * as path from 'node:path';
import { RepoEntry } from '../repos/model';
import { SvnError, SvnErrorKind } from '../svn/errors';
import { StatusEntry } from '../svn/xml';
import { Logger, nullLogger } from '../util/logger';
import { ChangeItem, RemoteInfo, aggregateIncoming, buildItems, isSameOrUnder, remoteMapFrom } from './model';

export interface RepoState {
  repoName: string;
  items: ChangeItem[];
  /** Server revision seen by the last successful remote check. */
  youngest?: number;
  remoteCheckedAt?: number;
  localCheckedAt?: number;
  /** Set when the last run failed; items keep the last good data. */
  error?: { kind: SvnErrorKind | 'other'; message: string };
}

export interface StatusSource {
  status(target: string, opts: { showUpdates?: boolean; repoName?: string; signal?: AbortSignal }): Promise<{ entries: StatusEntry[]; youngest?: number }>;
}

export interface RefreshOptions {
  /** Restrict to one repo; default all. */
  repoName?: string;
  /** Contact the server (`status -u`). Default true for refresh(), false for requestRefresh(). */
  remote?: boolean;
  /** User-initiated: clears the auth/cert backoff. */
  manual?: boolean;
}

const BACKOFF_KINDS = new Set<string>(['auth', 'certificate', 'svnNotFound']);
const DEBOUNCE_MS = 600;

/** Per-repo cache of outgoing and incoming changes; the single source for the pane, context keys and guards. */
export class IncomingService {
  private readonly states = new Map<string, RepoState>();
  private readonly remote = new Map<string, Map<string, RemoteInfo>>();
  private readonly inflight = new Map<string, { remote: boolean; promise: Promise<void>; ac: AbortController }>();
  private readonly blocked = new Set<string>();
  private readonly changeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(repo: RepoEntry, err: unknown) => void>();
  private readonly busyListeners = new Set<() => void>();
  private busy = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private pendingRepos: Set<string> | 'all' = new Set();
  private pendingRemote = false;
  /** Repos whose refresh was held back while busy; value = whether a server check was wanted. */
  private readonly deferred = new Map<string, boolean>();
  private poll?: ReturnType<typeof setTimeout>;
  private intervalMs = 0;
  private disposed = false;
  /** Raw status entries of every successful run (all entries, including unchanged-but-locked); used by the lock service. */
  /** True while an SVN operation of ours runs on the repo; the poll and auto-refresh then wait (a manual refresh does not). */
  isRepoBusy?: (repoName: string) => boolean;
  /** Paths of a repo covered by the open workspace (see scope.ts); [] hides the repo. Default: the whole working copy. */
  scope?: (repo: RepoEntry) => string[];
  onEntries?: (repo: RepoEntry, entries: readonly StatusEntry[], remote: boolean) => void;

  constructor(
    private readonly client: StatusSource,
    private readonly listRepos: () => RepoEntry[],
    private readonly logger: Logger = nullLogger,
  ) {}

  onDidChange(cb: () => void): { dispose(): void } {
    this.changeListeners.add(cb);
    return { dispose: () => this.changeListeners.delete(cb) };
  }

  /** Fired when a repo's error kind changes, so a persistent failure is reported once and not on every poll. */
  onDidError(cb: (repo: RepoEntry, err: unknown) => void): { dispose(): void } {
    this.errorListeners.add(cb);
    return { dispose: () => this.errorListeners.delete(cb) };
  }

  /** True while any status check is running (drives the status bar spinner). */
  isBusy(): boolean {
    return this.busy > 0;
  }

  onDidChangeBusy(cb: () => void): { dispose(): void } {
    this.busyListeners.add(cb);
    return { dispose: () => this.busyListeners.delete(cb) };
  }

  private setBusy(delta: number): void {
    this.busy += delta;
    for (const l of [...this.busyListeners]) l();
  }

  getState(repoName: string): RepoState | undefined {
    return this.states.get(repoName);
  }

  /** Targets of the repo that are in scope (empty = hidden). */
  scopeOf(repo: RepoEntry): string[] {
    return this.scope ? this.scope(repo) : [repo.localFolder];
  }

  /** Configured repos that overlap the open workspace (all of them when scoping is off). */
  visibleRepos(): RepoEntry[] {
    return this.listRepos().filter((r) => this.scopeOf(r).length > 0);
  }

  /** Workspace folders or the scope setting changed: drop cached server info (it covered another scope) and re-check. */
  scopeChanged(): void {
    this.remote.clear();
    this.states.clear();
    this.emitChange();
    void this.refresh({ remote: true });
  }

  /** States of visible repos, in settings order. */
  allStates(): RepoState[] {
    return this.visibleRepos().map((r) => this.states.get(r.name)).filter((s): s is RepoState => !!s);
  }

  allItems(): ChangeItem[] {
    return this.allStates().flatMap((s) => s.items);
  }

  /** Incoming items at or under fsPath (a file, folder or the whole working copy). */
  incomingUnder(fsPath: string): ChangeItem[] {
    return this.allItems().filter((i) => i.incoming && isSameOrUnder(i.path, fsPath));
  }

  hasIncoming(fsPath: string): boolean {
    return this.incomingUnder(fsPath).length > 0;
  }

  /** Incoming item paths plus all ancestor folders up to each repo root; feeds the `incomingPaths` context key. */
  aggregatedIncomingPaths(): string[] {
    const out: string[] = [];
    for (const repo of this.visibleRepos()) {
      const inc = this.states.get(repo.name)?.items.filter((i) => i.incoming).map((i) => i.path) ?? [];
      if (inc.length) out.push(...aggregateIncoming(inc, repo.localFolder));
    }
    return out;
  }

  /** Runs now and resolves when done. Never rejects: failures are recorded in the repo state. */
  async refresh(opts: RefreshOptions = {}): Promise<void> {
    const remote = opts.remote ?? true;
    this.prune();
    const repos = this.visibleRepos().filter((r) => !opts.repoName || r.name === opts.repoName);
    if (opts.manual) for (const r of repos) this.blocked.delete(r.name);
    await Promise.all(repos.map((r) => this.refreshRepo(r, remote, !!opts.manual)));
    this.emitChange();
  }

  /** An operation of ours on the repo finished: run the refresh that was held back (if any). */
  repoReleased(repoName: string): void {
    const remote = this.deferred.get(repoName);
    if (remote === undefined) return;
    this.deferred.delete(repoName);
    this.requestRefresh({ repoName, remote });
  }

  /** Debounced refresh for save/file-system events and post-operation hooks. */
  requestRefresh(opts: RefreshOptions = {}): void {
    if (this.disposed) return;
    if (opts.remote) this.pendingRemote = true;
    if (!opts.repoName) this.pendingRepos = 'all';
    else if (this.pendingRepos !== 'all') this.pendingRepos.add(opts.repoName);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const repos = this.pendingRepos;
      const remote = this.pendingRemote;
      this.pendingRepos = new Set();
      this.pendingRemote = false;
      this.timer = undefined;
      if (repos === 'all') void this.refresh({ remote });
      else for (const repoName of repos) void this.refresh({ repoName, remote });
    }, DEBOUNCE_MS);
  }

  /** Periodic server check; 0 disables. Backed-off repos (auth/cert errors) are skipped until a manual refresh. */
  setCheckInterval(ms: number): void {
    this.intervalMs = ms;
    if (this.poll) clearTimeout(this.poll);
    this.poll = undefined;
    if (ms > 0 && !this.disposed) this.schedulePoll();
  }

  /** Repo list or settings changed: drop stale state and re-check. */
  reposChanged(): void {
    this.blocked.clear();
    this.prune();
    this.emitChange();
    void this.refresh({ remote: true });
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearTimeout(this.poll);
    for (const f of this.inflight.values()) f.ac.abort();
    this.changeListeners.clear();
    this.errorListeners.clear();
    this.busyListeners.clear();
  }

  private schedulePoll(): void {
    this.poll = setTimeout(() => {
      if (this.disposed) return;
      const repos = this.visibleRepos().filter((r) => !this.blocked.has(r.name));
      void Promise.all(repos.map((r) => this.refreshRepo(r, true))).then(() => {
        this.emitChange();
        if (this.intervalMs > 0 && !this.disposed) this.schedulePoll();
      });
    }, this.intervalMs);
    this.poll.unref?.();
  }

  private prune(): void {
    const names = new Set(this.listRepos().map((r) => r.name));
    for (const k of [...this.states.keys()]) {
      if (!names.has(k)) {
        this.states.delete(k);
        this.remote.delete(k);
        this.blocked.delete(k);
        this.deferred.delete(k);
      }
    }
  }

  private emitChange(): void {
    for (const l of [...this.changeListeners]) l();
  }

  private async refreshRepo(repo: RepoEntry, remote: boolean, force = false): Promise<void> {
    if (!force && this.isRepoBusy?.(repo.name)) {
      this.deferred.set(repo.name, remote || this.deferred.get(repo.name) === true);
      return;
    }
    const cur = this.inflight.get(repo.name);
    if (cur) {
      if (cur.remote || !remote) return cur.promise;
      await cur.promise;
    }
    const ac = new AbortController();
    this.setBusy(1);
    const promise = this.runRepo(repo, remote, ac.signal).finally(() => {
      if (this.inflight.get(repo.name)?.ac === ac) this.inflight.delete(repo.name);
      this.setBusy(-1);
    });
    this.inflight.set(repo.name, { remote, promise, ac });
    return promise;
  }

  private async runRepo(repo: RepoEntry, remote: boolean, signal: AbortSignal): Promise<void> {
    const abs = (p: string): string => path.resolve(repo.localFolder, p);
    const prev = this.states.get(repo.name);
    try {
      const targets = this.scopeOf(repo);
      if (!targets.length) return;
      const runs: Array<{ entries: StatusEntry[]; youngest?: number }> = [];
      for (const t of targets) {
        runs.push(await this.client.status(t, { showUpdates: remote, repoName: repo.name, signal }));
        if (signal.aborted) return;
      }
      const res = { entries: runs.flatMap((r) => r.entries), youngest: runs.map((r) => r.youngest).find((y) => y !== undefined) };
      let remoteMap = this.remote.get(repo.name) ?? new Map<string, RemoteInfo>();
      if (remote) {
        remoteMap = remoteMapFrom(res.entries, abs);
        this.remote.set(repo.name, remoteMap);
      }
      this.onEntries?.(repo, res.entries, remote);
      const now = Date.now();
      this.states.set(repo.name, {
        repoName: repo.name,
        items: buildItems(repo.name, res.entries, remoteMap, abs),
        youngest: remote ? res.youngest : prev?.youngest,
        remoteCheckedAt: remote ? now : prev?.remoteCheckedAt,
        localCheckedAt: now,
      });
      this.blocked.delete(repo.name);
    } catch (e) {
      if (signal.aborted || (e instanceof SvnError && e.kind === 'cancelled')) return;
      const kind = e instanceof SvnError ? e.kind : 'other';
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Status check failed for "${repo.name}" (${kind}): ${message}`);
      const changed = prev?.error?.kind !== kind;
      this.states.set(repo.name, { ...(prev ?? { repoName: repo.name, items: [] }), error: { kind, message } });
      if (BACKOFF_KINDS.has(kind)) this.blocked.add(repo.name);
      if (changed) for (const l of [...this.errorListeners]) l(repo, e);
    }
  }
}

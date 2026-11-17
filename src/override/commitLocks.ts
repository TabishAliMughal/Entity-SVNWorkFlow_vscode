/** In-process mutual exclusion per repo, so two override runs (or an override and a restore) never overlap. */
export class RepoLocks {
  private readonly held = new Set<string>();
  private readonly releaseListeners = new Set<(repoName: string) => void>();

  /** Called with the repo name whenever a lock is released (for refreshes held back while the repo was busy). */
  onRelease(cb: (repoName: string) => void): { dispose(): void } {
    this.releaseListeners.add(cb);
    return { dispose: () => this.releaseListeners.delete(cb) };
  }

  /** Returns a release function, or undefined when the repo is already busy. */
  tryAcquire(repoName: string): (() => void) | undefined {
    const key = repoName.toLowerCase();
    if (this.held.has(key)) return undefined;
    this.held.add(key);
    return () => {
      if (!this.held.delete(key)) return;
      for (const l of [...this.releaseListeners]) l(repoName);
    };
  }

  isBusy(repoName: string): boolean {
    return this.held.has(repoName.toLowerCase());
  }
}

export const repoLocks = new RepoLocks();

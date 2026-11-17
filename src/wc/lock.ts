import { RepoLocks, repoLocks } from '../override/commitLocks';

export type LockResult = { release: () => void } | { busy: string };

/** Takes the per-repo locks of all names at once; if one is busy nothing stays acquired. */
export function acquireRepoLocks(names: readonly string[], locks: RepoLocks = repoLocks): LockResult {
  const held: Array<() => void> = [];
  for (const n of [...new Set(names.map((x) => x.toLowerCase()))]) {
    const r = locks.tryAcquire(n);
    if (!r) {
      held.forEach((h) => h());
      return { busy: names.find((x) => x.toLowerCase() === n) ?? n };
    }
    held.push(r);
  }
  return { release: () => held.forEach((h) => h()) };
}

export class RepoBusyError extends Error {
  constructor(public readonly repoName: string) {
    super(`An SVN operation is in progress on "${repoName}". Wait for it to finish and try again.`);
    this.name = 'RepoBusyError';
  }
}

/** Runs `fn` while holding the repo's lock; throws RepoBusyError (never runs `fn`) when another operation holds it. */
export async function runExclusive<T>(repoName: string, fn: () => Promise<T>, locks: RepoLocks = repoLocks): Promise<T> {
  const l = acquireRepoLocks([repoName], locks);
  if ('busy' in l) throw new RepoBusyError(l.busy);
  try {
    return await fn();
  } finally {
    l.release();
  }
}

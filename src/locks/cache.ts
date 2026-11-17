import * as path from 'node:path';
import { pathKey } from '../incoming/model';
import { LockInfo, StatusEntry } from '../svn/xml';
import { LockView, lockView } from './model';

interface Slot {
  path: string;
  local?: LockInfo;
  remote?: LockInfo;
}

/**
 * Locks seen by the periodic status runs, per repo. A remote run (`status -u`) is authoritative for both kinds of
 * lock; a local run only refreshes the working-copy tokens and keeps the server locks from the last remote run.
 */
export class LockCache {
  private readonly repos = new Map<string, { slots: Map<string, Slot>; remoteKnown: boolean }>();
  private readonly listeners = new Set<() => void>();

  onDidChange(cb: () => void): { dispose(): void } {
    this.listeners.add(cb);
    return { dispose: () => this.listeners.delete(cb) };
  }

  update(repoName: string, root: string, entries: readonly StatusEntry[], remote: boolean): void {
    const prev = this.repos.get(repoName);
    const slots = new Map<string, Slot>();
    const abs = (p: string): string => path.resolve(root, p);
    if (!remote && prev) {
      // A server lock that was ours (same token) and is no longer held locally was released: drop it until the next remote run.
      for (const [k, s] of prev.slots) if (s.remote && !(s.local?.token && s.local.token === s.remote.token)) slots.set(k, { path: s.path, remote: s.remote });
    }
    for (const e of entries) {
      if (!e.lock && !(remote && e.repoLock)) continue;
      const p = abs(e.path);
      const k = pathKey(p);
      const slot = slots.get(k) ?? { path: p };
      slot.local = e.lock;
      if (remote) slot.remote = e.repoLock;
      slots.set(k, slot);
    }
    this.repos.set(repoName, { slots, remoteKnown: remote || !!prev?.remoteKnown });
    for (const l of [...this.listeners]) l();
  }

  drop(repoName: string): void {
    if (this.repos.delete(repoName)) for (const l of [...this.listeners]) l();
  }

  /** Lock view of a file; 'none' when nothing is known. */
  get(repoName: string, p: string): LockView {
    const r = this.repos.get(repoName);
    const s = r?.slots.get(pathKey(p));
    return s ? lockView(s.local, s.remote, !!r?.remoteKnown) : { state: 'none' };
  }

  /** Lock view by path only (decorations know no repo name). */
  find(p: string): LockView {
    const k = pathKey(p);
    for (const r of this.repos.values()) {
      const s = r.slots.get(k);
      if (s) return lockView(s.local, s.remote, r.remoteKnown);
    }
    return { state: 'none' };
  }

  all(repoName?: string): Array<{ path: string; view: LockView }> {
    const out: Array<{ path: string; view: LockView }> = [];
    for (const [name, r] of this.repos) {
      if (repoName && name !== repoName) continue;
      for (const s of r.slots.values()) out.push({ path: s.path, view: lockView(s.local, s.remote, r.remoteKnown) });
    }
    return out;
  }
}

/** Shared by the pane (tooltips), file decorations and the hover; fed from the incoming status runs. */
export const lockCache = new LockCache();

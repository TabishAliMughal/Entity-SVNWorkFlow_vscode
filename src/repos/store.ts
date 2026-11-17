import { RepoEntry } from './model';
import { ServerStore } from './servers';

/** The working copy found for the focus folder: nothing about it is persisted. */
export interface CurrentRepo {
  /** Display name: the opened folder's name. */
  name: string;
  /** URL the working copy root tracks. */
  serverUrl: string;
  /** Working copy root. */
  localFolder: string;
  repositoryRoot?: string;
  uuid?: string;
}

/**
 * Holds at most one repository: the working copy containing the opened folder. It is found on the fly and
 * never saved; per-server settings (username, certificate trust, trusted externals hosts) come from ServerStore.
 */
export class RepoStore {
  private readonly listeners = new Set<() => void>();
  private current?: CurrentRepo;

  constructor(private readonly servers: ServerStore) {}

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  notifyChanged(): void {
    for (const l of [...this.listeners]) l();
  }

  getCurrent(): CurrentRepo | undefined {
    return this.current;
  }

  /** Sets the discovered working copy; returns true (and notifies) when it differs from the previous one. */
  setCurrent(next: CurrentRepo | undefined): boolean {
    const a = this.current;
    const same = a?.name === next?.name && a?.serverUrl === next?.serverUrl && a?.localFolder === next?.localFolder;
    this.current = next;
    if (!same) this.notifyChanged();
    return !same;
  }

  list(): RepoEntry[] {
    const c = this.current;
    if (!c) return [];
    const s = this.servers.get(c.serverUrl);
    return [{ name: c.name, serverUrl: c.serverUrl, localFolder: c.localFolder, username: s.username, trustServerCert: s.trustServerCert, trustedCertFingerprint: s.trustedCertFingerprint, trustedExternalHosts: s.trustedExternalHosts }];
  }

  find(name: string): RepoEntry | undefined {
    return this.list().find((r) => r.name.toLowerCase() === name.toLowerCase());
  }

  /** Stores the per-server fields of `entry`; a changed serverUrl (relocate) updates the current repository. */
  async update(oldName: string, entry: RepoEntry): Promise<void> {
    if (!this.current || this.current.name.toLowerCase() !== oldName.toLowerCase()) throw new Error(`Repository "${oldName}" is not the current working copy.`);
    await this.servers.set(entry.serverUrl, entry);
    if (entry.serverUrl !== this.current.serverUrl) this.setCurrent({ ...this.current, serverUrl: entry.serverUrl });
    else this.notifyChanged();
  }
}

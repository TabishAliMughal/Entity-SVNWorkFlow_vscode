import { originOf } from '../externals/model';

/** Per-server (scheme://host:port) settings that used to live on saved repository entries. */
export interface ServerSettings {
  username?: string;
  trustServerCert?: boolean;
  trustedCertFingerprint?: string;
  trustedExternalHosts?: string[];
}

/** Subset of vscode.Memento. */
export interface MementoLike {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export const SERVERS_KEY = 'svnWorkflow.servers';

export function serverKey(urlOrOrigin: string): string {
  return (originOf(urlOrOrigin) ?? urlOrOrigin).toLowerCase();
}

function clean(s: ServerSettings): ServerSettings {
  return {
    username: s.username || undefined,
    trustServerCert: s.trustServerCert === true ? true : undefined,
    trustedCertFingerprint: s.trustedCertFingerprint || undefined,
    trustedExternalHosts: s.trustedExternalHosts?.length ? [...new Set(s.trustedExternalHosts)] : undefined,
  };
}

/** Username, certificate trust and trusted externals hosts per server origin, kept in extension global state. */
export class ServerStore {
  constructor(private readonly state: MementoLike) {}

  private all(): Record<string, ServerSettings> {
    const raw = this.state.get<Record<string, ServerSettings>>(SERVERS_KEY, {});
    return raw && typeof raw === 'object' ? raw : {};
  }

  get(urlOrOrigin: string): ServerSettings {
    return clean(this.all()[serverKey(urlOrOrigin)] ?? {});
  }

  async set(urlOrOrigin: string, next: ServerSettings): Promise<void> {
    const all = { ...this.all() };
    const c = clean(next);
    if (Object.values(c).every((v) => v === undefined)) delete all[serverKey(urlOrOrigin)];
    else all[serverKey(urlOrOrigin)] = JSON.parse(JSON.stringify(c)) as ServerSettings;
    await this.state.update(SERVERS_KEY, all);
  }

  origins(): string[] {
    return Object.keys(this.all());
  }
}

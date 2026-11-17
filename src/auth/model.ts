import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Subversion's on-disk credential kinds under %APPDATA%\Subversion\auth. */
export const AUTH_KINDS = ['svn.simple', 'svn.username', 'svn.ssl.server', 'svn.ssl.client-passphrase'] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

const DEFAULT_PORTS: Record<string, string> = { 'svn:': '3690', 'http:': '80', 'https:': '443', 'svn+ssh:': '22' };

export function authDirOf(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.APPDATA ? path.join(env.APPDATA, 'Subversion', 'auth') : undefined;
}

/** Lowercase `scheme://host:port` (default port made explicit) or undefined. */
export function originOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (!u.hostname) return undefined;
    return `${u.protocol}//${u.hostname.toLowerCase()}:${u.port || DEFAULT_PORTS[u.protocol] || ''}`;
  } catch {
    return undefined;
  }
}

/** Parses svn's hash-file format ("K <n>\nkey\nV <n>\nvalue\n ... END") into a map. */
export function parseHashFile(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let pos = 0;
  const line = (): string | undefined => {
    if (pos >= buf.length) return undefined;
    let end = buf.indexOf(0x0a, pos);
    if (end < 0) end = buf.length;
    const s = buf.subarray(pos, end).toString('utf8').replace(/\r$/, '');
    pos = end + 1;
    return s;
  };
  const chunk = (len: number): Buffer => {
    const b = buf.subarray(pos, pos + len);
    pos += len + 1;
    return b;
  };
  for (;;) {
    const k = line();
    if (k === undefined || k === 'END') break;
    const km = /^K (\d+)$/.exec(k);
    if (!km) break;
    const key = chunk(Number(km[1])).toString('utf8');
    const v = line();
    const vm = v === undefined ? null : /^V (\d+)$/.exec(v);
    if (!vm) break;
    out.set(key, chunk(Number(vm[1])));
  }
  return out;
}

export interface AuthEntry {
  kind: AuthKind;
  file: string;
  realm: string;
  /** Never the password. */
  username?: string;
  /** Origin extracted from the realm, e.g. https://host:443. */
  origin?: string;
  /** Names of configured repos on that origin. */
  repos: string[];
}

export function originFromRealm(realm: string): string | undefined {
  const m = /^<([^>]+)>/.exec(realm);
  return originOf(m ? m[1] : realm.trim());
}

export interface RepoLike {
  name: string;
  serverUrl: string;
}

export async function listAuthCache(authDir: string, repos: readonly RepoLike[]): Promise<AuthEntry[]> {
  const byOrigin = new Map<string, string[]>();
  for (const r of repos) {
    const o = originOf(r.serverUrl);
    if (o) byOrigin.set(o, [...(byOrigin.get(o) ?? []), r.name]);
  }
  const out: AuthEntry[] = [];
  for (const kind of AUTH_KINDS) {
    const dir = path.join(authDir, kind);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      const file = path.join(dir, n);
      try {
        const h = parseHashFile(await fs.readFile(file));
        const realm = h.get('svn:realmstring')?.toString('utf8');
        if (!realm) continue;
        const origin = originFromRealm(realm);
        out.push({ kind, file, realm, origin, username: h.get('username')?.toString('utf8'), repos: origin ? (byOrigin.get(origin) ?? []) : [] });
      } catch {
        // unreadable entries are skipped
      }
    }
  }
  return out.sort((a, b) => a.realm.localeCompare(b.realm) || a.kind.localeCompare(b.kind));
}

/** Deletes the given cache files, only inside authDir. Returns how many were removed. */
export async function deleteAuthEntries(authDir: string, entries: readonly Pick<AuthEntry, 'file'>[]): Promise<number> {
  const root = path.resolve(authDir) + path.sep;
  let n = 0;
  for (const e of entries) {
    if (!path.resolve(e.file).toLowerCase().startsWith(root.toLowerCase())) continue;
    try {
      await fs.rm(e.file);
      n++;
    } catch {
      // already gone
    }
  }
  return n;
}

export function describeAuthEntry(e: AuthEntry): string {
  const who = e.username ? `${e.username} @ ` : '';
  return `${who}${e.realm}`;
}

import * as crypto from 'node:crypto';
import { assertSafeRel } from '../util/safePath';

export type ShelveMode = 'auto' | 'native' | 'patch';
export type Backend = 'native' | 'patch';

export function parseShelveMode(v: unknown): ShelveMode {
  return v === 'native' || v === 'patch' ? v : 'auto';
}

/** `SVN_EXPERIMENTAL_COMMANDS` values to probe, newest shelf format first (svn 1.14 uses `shelf3`). */
export const NATIVE_ENV_VALUES = ['shelf3', 'shelf2', 'shelf'] as const;

export function validateShelfName(name: string): string | undefined {
  const n = name.trim();
  if (!n) return 'Enter a name.';
  if (n.length > 64) return 'Use at most 64 characters.';
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(n)) return 'Use letters, digits, "_", "." and "-" (no spaces; must not start with "." or "-").';
  return undefined;
}

/** Which backend serves a request. Throws when `native` is forced but missing. */
export function resolveBackend(mode: ShelveMode, nativeAvailable: boolean): Backend {
  if (mode === 'patch') return 'patch';
  if (mode === 'native') {
    if (!nativeAvailable) throw new Error('Native shelving (svn x-shelve, experimental) is not available in this svn. Set svnWorkflow.shelve.mode to "auto" or "patch".');
    return 'native';
  }
  return nativeAvailable ? 'native' : 'patch';
}

export interface ShelfFile {
  /** Relative to the working copy root, posix separators. */
  path: string;
  status: 'modified' | 'added' | 'deleted';
  /** Stored as a copy of the file (svn patch cannot carry binary content). */
  binary: boolean;
}

export interface ShelfMeta {
  format: 1;
  name: string;
  message: string;
  createdAt: string;
  repoName: string;
  files: ShelfFile[];
}

export function parseShelfMeta(json: string): ShelfMeta {
  const o = JSON.parse(json) as Partial<ShelfMeta>;
  if (o?.format !== 1 || typeof o.name !== 'string' || !Array.isArray(o.files)) throw new Error('Not a shelf metadata file');
  return {
    format: 1,
    name: o.name,
    message: typeof o.message === 'string' ? o.message : '',
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : '',
    repoName: typeof o.repoName === 'string' ? o.repoName : '',
    files: o.files
      .filter((f) => f && typeof f.path === 'string')
      .map((f) => ({ path: assertSafeRel(f.path, 'shelf file path'), status: f.status === 'added' || f.status === 'deleted' ? f.status : 'modified', binary: !!f.binary })),
  };
}

/** Folder name for a repo or shelf: readable plus a hash so different names never collide after sanitising. */
export function slug(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'x';
  return `${safe}-${crypto.createHash('sha1').update(name).digest('hex').slice(0, 6)}`;
}

export interface NativeShelf {
  name: string;
  version?: number;
  age?: string;
  paths?: number;
  message: string;
  /** `no versions`: a leftover of a failed shelve. */
  broken: boolean;
}

/** Parses `svn x-shelf-list` (not `-q`, which crashes svn 1.14.2 on Windows). */
export function parseNativeList(text: string): NativeShelf[] {
  const out: NativeShelf[] = [];
  let cur: NativeShelf | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    const ok = /^(\S+)\s+version (\d+), (.+?) ago, (\d+) paths? changed$/.exec(line);
    const none = /^(\S+)\s+no versions$/.exec(line);
    if (ok) {
      cur = { name: ok[1], version: +ok[2], age: ok[3], paths: +ok[4], message: '', broken: false };
      out.push(cur);
    } else if (none) {
      cur = { name: none[1], message: '', broken: true };
      out.push(cur);
    } else if (cur && line.startsWith(' ') && !cur.message) {
      cur.message = line.trim();
    }
  }
  return out;
}

/** svn without the experimental command prints this for an unknown or disabled subcommand. */
export function isUnknownCommand(text: string): boolean {
  return /unknown (sub)?command|Unknown subcommand/i.test(text);
}

export interface ShelfInfo {
  name: string;
  backend: Backend;
  message: string;
  /** ISO date (patch) or a relative age such as "3 minutes" (native). */
  when?: string;
  fileCount: number;
  broken?: boolean;
}

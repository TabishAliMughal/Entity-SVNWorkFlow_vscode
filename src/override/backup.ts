import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { StatusEntry } from '../svn/xml';
import { assertSafeRel, assertUnder } from '../util/safePath';

export type BackupState = 'modified' | 'added' | 'moved' | 'deleted';
export type EntryKind = 'file' | 'dir' | 'none';

/** One local change that Override and Commit must preserve. Paths are relative to the working copy root, '/'-separated. */
export interface PlanEntry {
  rel: string;
  state: BackupState;
  /** Raw svn wc-status item at backup time (modified, added, deleted, missing, replaced, conflicted ...). */
  svnStatus: string;
  props: string;
  kind: EntryKind;
  /** Directory whose whole tree was copied (copied/moved folders). */
  recursive?: boolean;
  movedFrom?: string;
  movedTo?: string;
}

export interface BackupFile {
  /** Relative to the working copy root. */
  rel: string;
  size: number;
  sha256: string;
}

export interface BackupEntry extends PlanEntry {
  /** Hashes of every backed-up file (one for a file, many for a recursive folder). */
  files?: BackupFile[];
  /** Property name -> base64 value, for properties modified locally. */
  propValues?: Record<string, string>;
}

export interface BackupManifest {
  version: 1;
  createdAt: string;
  repoName: string;
  serverUrl?: string;
  wcRoot: string;
  /** The Override and Commit target, relative to wcRoot ('' for the working copy root). */
  targetRel: string;
  message: string;
  entries: BackupEntry[];
  /** Set once the commit succeeded. */
  completed?: { at: string; revision?: number };
  restoredAt?: string;
}

export const MANIFEST_NAME = 'manifest.json';
export const FILES_DIR = 'files';
export const MESSAGE_NAME = 'message.txt';

export const toRel = (wcRoot: string, abs: string): string => path.relative(wcRoot, abs).split(path.sep).join('/');
export const toAbs = (wcRoot: string, rel: string): string => {
  const abs = rel ? path.join(wcRoot, ...rel.split('/')) : wcRoot;
  return assertUnder(abs, wcRoot, 'backup path');
};

const depth = (rel: string): number => (rel ? rel.split('/').length : 0);

/** Builds the list of local changes from a (local, non -u) svn status. Pure apart from the `kindOf` probe. */
export function planEntries(entries: readonly StatusEntry[], wcRoot: string, kindOf: (abs: string) => EntryKind): PlanEntry[] {
  const out = new Map<string, PlanEntry>();
  for (const e of entries) {
    const abs = path.resolve(wcRoot, e.path);
    const rel = toRel(wcRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !rel) continue;
    const movedFrom = e.movedFrom ? toRel(wcRoot, path.resolve(wcRoot, e.movedFrom)) : undefined;
    const movedTo = e.movedTo ? toRel(wcRoot, path.resolve(wcRoot, e.movedTo)) : undefined;
    const base = { rel, svnStatus: e.item, props: e.props };
    const kind = kindOf(abs);
    let plan: PlanEntry | undefined;
    switch (e.item) {
      case 'modified':
      case 'replaced':
      case 'conflicted':
        plan = { ...base, state: 'modified', kind };
        break;
      case 'normal':
        if (e.props === 'modified' || e.props === 'conflicted' || e.treeConflicted) plan = { ...base, state: 'modified', kind };
        break;
      case 'added':
        plan = movedFrom
          ? { ...base, state: 'moved', kind, movedFrom, recursive: kind === 'dir' || undefined }
          : { ...base, state: 'added', kind, recursive: (kind === 'dir' && e.copied) || undefined };
        break;
      case 'deleted':
      case 'missing':
        plan = { ...base, state: 'deleted', kind: 'none', movedTo };
        break;
      default:
        break;
    }
    if (plan) out.set(rel, plan);
  }
  return [...out.values()].sort((a, b) => depth(a.rel) - depth(b.rel) || a.rel.localeCompare(b.rel));
}

const LETTER: Record<BackupState, string> = { modified: 'M', added: 'A', moved: 'R', deleted: 'D' };

export function describeEntry(e: PlanEntry): string {
  const extra = e.state === 'moved' && e.movedFrom ? `  (from ${e.movedFrom})` : '';
  return `${LETTER[e.state]}  ${e.rel}${extra}`;
}

export function timestampName(d: Date, repoName: string): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${repoName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'repo'}`;
}

export async function hashFile(file: string): Promise<{ size: number; sha256: string }> {
  const h = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    h.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { size, sha256: h.digest('hex') };
}

async function walkFiles(dir: string, relBase: string, out: Array<{ abs: string; rel: string }> = []): Promise<Array<{ abs: string; rel: string }>> {
  for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
    if (d.name === '.svn') continue;
    const abs = path.join(dir, d.name);
    const rel = relBase ? `${relBase}/${d.name}` : d.name;
    if (d.isDirectory()) await walkFiles(abs, rel, out);
    else out.push({ abs, rel });
  }
  return out;
}

async function makeWritable(file: string): Promise<void> {
  await fsp.chmod(file, 0o666).catch(() => undefined);
}

/** Copies src over dst byte-for-byte, creating folders and clearing a read-only flag on an existing target. */
export async function copyBytes(src: string, dst: string): Promise<void> {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await makeWritable(dst);
  await fsp.copyFile(src, dst);
}

export interface CreateBackupOptions {
  backupRoot: string;
  repoName: string;
  serverUrl?: string;
  wcRoot: string;
  target: string;
  message: string;
  entries: readonly PlanEntry[];
  propValues?: ReadonlyMap<string, Record<string, string>>;
  now?: Date;
}

export class BackupVerifyError extends Error {
  constructor(message: string, public readonly backupDir: string) {
    super(message);
    this.name = 'BackupVerifyError';
  }
}

/**
 * Copies the local content of every entry to <backupRoot>/<timestamp>-<repo>/files/<rel>, verifies sizes and
 * SHA-256 against the source, then writes manifest.json. Throws (and removes the half-made folder) on any mismatch.
 */
export async function createBackup(o: CreateBackupOptions): Promise<{ dir: string; manifest: BackupManifest }> {
  await fsp.mkdir(o.backupRoot, { recursive: true });
  const base = timestampName(o.now ?? new Date(), o.repoName);
  let dir = path.join(o.backupRoot, base);
  for (let n = 2; ; n++) {
    try {
      await fsp.mkdir(dir);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      dir = path.join(o.backupRoot, `${base}-${n}`);
    }
  }
  const filesRoot = path.join(dir, FILES_DIR);
  try {
    const entries: BackupEntry[] = [];
    for (const e of o.entries) {
      const entry: BackupEntry = { ...e };
      const pv = o.propValues?.get(e.rel);
      if (pv && Object.keys(pv).length) entry.propValues = pv;
      if (e.state !== 'deleted' && e.kind === 'file') {
        entry.files = [await copyAndHash(toAbs(o.wcRoot, e.rel), path.join(filesRoot, ...e.rel.split('/')), e.rel)];
      } else if (e.state !== 'deleted' && e.kind === 'dir') {
        entry.files = [];
        if (e.recursive) {
          for (const f of await walkFiles(toAbs(o.wcRoot, e.rel), e.rel)) {
            entry.files.push(await copyAndHash(f.abs, path.join(filesRoot, ...f.rel.split('/')), f.rel));
          }
        } else {
          await fsp.mkdir(path.join(filesRoot, ...e.rel.split('/')), { recursive: true });
        }
      }
      entries.push(entry);
    }
    const manifest: BackupManifest = {
      version: 1,
      createdAt: (o.now ?? new Date()).toISOString(),
      repoName: o.repoName,
      serverUrl: o.serverUrl,
      wcRoot: o.wcRoot,
      targetRel: toRel(o.wcRoot, o.target),
      message: o.message,
      entries,
    };
    await fsp.writeFile(path.join(dir, MESSAGE_NAME), o.message, 'utf8');
    await writeManifest(dir, manifest);
    await verifyBackup(dir);
    return { dir, manifest };
  } catch (e) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw e instanceof BackupVerifyError ? e : new BackupVerifyError(`Could not create the local backup (nothing was changed): ${(e as Error).message}`, dir);
  }
}

async function copyAndHash(src: string, dst: string, rel: string): Promise<BackupFile> {
  await copyBytes(src, dst);
  const [a, b] = await Promise.all([hashFile(src), hashFile(dst)]);
  if (a.size !== b.size || a.sha256 !== b.sha256) throw new BackupVerifyError(`Backup verification failed for ${rel}`, dst);
  return { rel, size: a.size, sha256: a.sha256 };
}

export async function writeManifest(dir: string, manifest: BackupManifest): Promise<void> {
  const tmp = path.join(dir, `${MANIFEST_NAME}.tmp`);
  await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
  await fsp.rename(tmp, path.join(dir, MANIFEST_NAME));
}

export async function readManifest(dir: string): Promise<BackupManifest> {
  const m = JSON.parse(await fsp.readFile(path.join(dir, MANIFEST_NAME), 'utf8')) as BackupManifest;
  if (m?.version !== 1 || !Array.isArray(m.entries)) throw new Error(`Unsupported backup manifest in ${dir}`);
  try {
    assertSafeRel(m.targetRel, 'target path', true);
    for (const e of m.entries) {
      assertSafeRel(e.rel, 'entry path');
      if (e.movedFrom !== undefined) assertSafeRel(e.movedFrom, 'moved-from path');
      if (e.movedTo !== undefined) assertSafeRel(e.movedTo, 'moved-to path');
      for (const f of e.files ?? []) assertSafeRel(f.rel, 'file path');
    }
  } catch (err) {
    throw new Error(`Backup manifest in ${dir} is not trusted: ${(err as Error).message}`, { cause: err });
  }
  return m;
}

/** Re-reads the manifest and checks every backed-up file's size and hash. Throws BackupVerifyError on any difference. */
export async function verifyBackup(dir: string): Promise<BackupManifest> {
  const m = await readManifest(dir);
  for (const e of m.entries) {
    for (const f of e.files ?? []) {
      const p = path.join(dir, FILES_DIR, ...f.rel.split('/'));
      const h = await hashFile(p).catch(() => undefined);
      if (!h || h.size !== f.size || h.sha256 !== f.sha256) throw new BackupVerifyError(`Backup file is missing or damaged: ${f.rel}`, dir);
    }
  }
  return m;
}

export interface BackupInfo {
  dir: string;
  manifest: BackupManifest;
}

/** Newest first. Folders without a readable manifest are skipped. */
export async function listBackups(backupRoot: string): Promise<BackupInfo[]> {
  const names = await fsp.readdir(backupRoot).catch(() => [] as string[]);
  const out: BackupInfo[] = [];
  for (const n of names) {
    const dir = path.join(backupRoot, n);
    try {
      out.push({ dir, manifest: await readManifest(dir) });
    } catch {
      /* not a backup */
    }
  }
  return out.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
}

export async function deleteBackup(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true });
}

export async function markCompleted(dir: string, revision: number | undefined, now = new Date()): Promise<void> {
  const m = await readManifest(dir);
  m.completed = { at: now.toISOString(), revision };
  await writeManifest(dir, m);
}

/** Keeps the newest `keep` committed backups; backups of failed runs are never pruned automatically. */
export async function pruneCommitted(backupRoot: string, keep: number): Promise<string[]> {
  const committed = (await listBackups(backupRoot)).filter((b) => b.manifest.completed);
  const doomed = committed.slice(Math.max(0, keep));
  for (const b of doomed) await deleteBackup(b.dir);
  return doomed.map((b) => b.dir);
}

export function backupFilePath(dir: string, rel: string): string {
  return path.join(dir, FILES_DIR, ...rel.split('/'));
}

export { walkFiles as listBackedUpFiles };

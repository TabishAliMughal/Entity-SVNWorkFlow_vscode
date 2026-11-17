import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { isSameOrUnder } from '../incoming/model';
import { dedupeNested, parseUpdateConflicts, parseUpdatedRevision } from '../ops/targets';
import { RepoEntry } from '../repos/model';
import { Credentials, SvnClient, pegSafe } from '../svn/client';
import { SvnError } from '../svn/errors';
import { SvnInfo, StatusEntry, parseStatus } from '../svn/xml';
import { parseList } from '../svn/list';
import { Depth, MissingWithMeta, NewItem, RevertCandidate, RevertStep, SetDepth, cleanupArgs, CleanupOptions, junkEntries, pairMoves, parseLockedPaths, revertOrder } from './model';

export interface WcCtx {
  client: SvnClient;
  repo: RepoEntry;
  signal?: AbortSignal;
}

const o = (c: WcCtx) => ({ repoName: c.repo.name, cwd: c.repo.localFolder, signal: c.signal });
const abs = (c: WcCtx, p: string): string => path.resolve(c.repo.localFolder, p);

// ---------- checkout / relocate ----------

export interface CheckoutParams {
  client: SvnClient;
  url: string;
  target: string;
  depth: Depth;
  credentials?: Credentials;
  revision?: string;
  signal?: AbortSignal;
}

/** `svn checkout`; the repo may not be registered yet, so credentials are passed explicitly. */
export async function checkout(p: CheckoutParams): Promise<{ revision?: number }> {
  const args = ['checkout', '--depth', p.depth];
  if (p.revision) args.push('-r', p.revision);
  args.push('--', p.url, p.target);
  const r = await p.client.run(args, { credentials: p.credentials ?? {}, signal: p.signal, timeoutMs: 6 * 60 * 60 * 1000 });
  const m = /Checked out revision (\d+)/i.exec(r.text);
  return { revision: m ? Number(m[1]) : undefined };
}

export function wcInfo(c: WcCtx, target = c.repo.localFolder): Promise<SvnInfo> {
  return c.client.info(target, { repoName: c.repo.name, cwd: c.repo.localFolder, signal: c.signal });
}

/** `svn relocate NEWURL WCROOT` (validates the repository UUID); WCROOT is literal, svn reads no peg revision there, so no pegSafe. Returns the working copy URL before the change. */
export async function relocate(c: WcCtx, newUrl: string, credentials?: Credentials): Promise<{ oldUrl: string }> {
  const before = await wcInfo(c);
  await c.client.run(['relocate', '--', newUrl, c.repo.localFolder], { ...o(c), ...(credentials ? { credentials, repoName: undefined } : {}) });
  return { oldUrl: before.url };
}

// ---------- listing (branch/tag/child pickers) ----------

export async function listRemote(c: WcCtx, url: string): Promise<Array<{ name: string; dir: boolean }>> {
  // --xml: the plain listing is in the console code page and mangles non-ASCII names; XML is always UTF-8
  const r = await c.client.run(['list', '--', url], { ...o(c), xml: true });
  return parseList(r.text).map((e) => ({ name: e.name, dir: e.kind === 'dir' }));
}

/** Directories under `^/<folder>` (e.g. branches, tags); a missing folder yields an empty list. */
export async function listRepoFolder(c: WcCtx, repoRoot: string, folder: string): Promise<string[]> {
  try {
    return (await listRemote(c, `${repoRoot.replace(/\/+$/, '')}/${folder}`)).filter((e) => e.dir).map((e) => e.name);
  } catch (e) {
    if (e instanceof SvnError && (e.kind === 'unknown' || e.kind === 'notWorkingCopy') && /E170000|E160013|E200009|doesn't exist|non-existent|not found/i.test(`${e.message} ${e.stderr}`)) return [];
    throw e;
  }
}

// ---------- revert / cleanup / upgrade ----------

export interface WcStatusItem extends RevertCandidate {
  entry: StatusEntry;
}

/** Local changes under `target` that revert can undo (fresh `svn status`, no network). */
export async function statusEntries(c: WcCtx, target: string, extra: readonly string[] = []): Promise<StatusEntry[]> {
  const r = await c.client.run(['status', ...extra, '--', pegSafe(target)], { ...o(c), xml: true });
  return parseStatus(r.text).entries.map((e) => ({ ...e, path: abs(c, e.path) }));
}

export function isDirSafe(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export async function revertSteps(c: WcCtx, steps: readonly RevertStep[]): Promise<void> {
  for (const s of revertOrder(steps)) {
    await c.client.run(['revert', '--depth', s.recursive ? 'infinity' : 'empty', '--', pegSafe(s.path)], o(c));
  }
}

export async function cleanup(c: WcCtx, targets: readonly string[], opts: CleanupOptions): Promise<void> {
  await c.client.run(cleanupArgs(opts, dedupeNested(targets).map(pegSafe)), o(c));
}

/** Deletes unversioned / ignored items selected in a preview; every path must lie inside the working copy. */
export async function removePaths(c: WcCtx, paths: readonly string[]): Promise<number> {
  let n = 0;
  for (const p of dedupeNested(paths)) {
    if (!isSameOrUnder(p, c.repo.localFolder)) throw new Error(`Refusing to delete outside the working copy: ${p}`);
    await fsp.rm(p, { recursive: true, force: true });
    n++;
  }
  return n;
}

export async function junkUnder(c: WcCtx, targets: readonly string[], kinds: { unversioned: boolean; ignored: boolean }): Promise<StatusEntry[]> {
  const out: StatusEntry[] = [];
  for (const t of dedupeNested(targets)) out.push(...junkEntries(await statusEntries(c, t, kinds.ignored ? ['--no-ignore'] : []), kinds));
  return out;
}

/** Releases repository locks held on files under the targets (`svn unlock --force`); returns what was unlocked. */
export async function breakRepoLocks(c: WcCtx, targets: readonly string[], preview = false): Promise<string[]> {
  const found: string[] = [];
  for (const t of dedupeNested(targets)) {
    const r = await c.client.run(['status', '--show-updates', '--xml', '--', pegSafe(t)], o(c));
    found.push(...parseLockedPaths(r.text).map((p) => abs(c, p)));
  }
  const uniq = [...new Set(found)];
  if (!preview && uniq.length) await c.client.run(['unlock', '--force', '--', ...uniq.map(pegSafe)], o(c));
  return uniq;
}

export async function upgradeWc(c: WcCtx, target: string): Promise<void> {
  await c.client.run(['upgrade', '--', pegSafe(target)], o(c));
}

// ---------- update to revision / switch / depth ----------

export interface UpdateOutcome {
  revision?: number;
  conflicts: string[];
}

export async function updateToRevision(c: WcCtx, paths: readonly string[], rev: string): Promise<UpdateOutcome> {
  const r = await c.client.run(['update', '-r', rev, '--', ...dedupeNested(paths).map(pegSafe)], o(c));
  return { revision: parseUpdatedRevision(r.text), conflicts: parseUpdateConflicts(r.text) };
}

/** `svn switch URL PATH`: like relocate, PATH is literal (a trailing `@` would be part of the name). */
export async function switchTo(c: WcCtx, target: string, url: string): Promise<UpdateOutcome> {
  const r = await c.client.run(['switch', '--', url, target], o(c));
  return { revision: parseUpdatedRevision(r.text), conflicts: parseUpdateConflicts(r.text) };
}

export async function setDepth(c: WcCtx, target: string, depth: SetDepth): Promise<UpdateOutcome> {
  const r = await c.client.run(['update', '--set-depth', depth, '--', pegSafe(target)], o(c));
  return { revision: parseUpdatedRevision(r.text), conflicts: parseUpdateConflicts(r.text) };
}

/** Sparse update: bring named children of a (shallow) folder into the working copy at full depth. */
export async function includeChildren(c: WcCtx, parent: string, names: readonly string[]): Promise<void> {
  for (const n of names) await c.client.run(['update', '--set-depth', 'infinity', '--', pegSafe(path.join(parent, n))], o(c));
}

/** Children that exist on the server but are not (fully) in the working copy yet. */
export async function remoteChildren(c: WcCtx, folder: string): Promise<Array<{ name: string; dir: boolean; present: boolean }>> {
  const info = await wcInfo(c, folder);
  const list = await listRemote(c, info.url);
  return list.map((e) => ({ ...e, present: fs.existsSync(path.join(folder, e.name)) }));
}

// ---------- file operations ----------

export async function deletePaths(c: WcCtx, paths: readonly string[]): Promise<void> {
  await c.client.run(['delete', '--force', '--', ...dedupeNested(paths).map(pegSafe)], o(c));
}

/** `svn move` (history kept). Parents of the destination are created and added when missing. */
export async function movePath(c: WcCtx, from: string, to: string): Promise<void> {
  await c.client.run(['move', '--parents', '--', pegSafe(from), pegSafe(to)], o(c));
}

export async function copyPath(c: WcCtx, from: string, to: string): Promise<void> {
  await c.client.run(['copy', '--parents', '--', pegSafe(from), pegSafe(to)], o(c));
}

/** `svn mkdir --parents`; a folder that already exists unversioned is added instead. */
export async function mkdirPath(c: WcCtx, dir: string): Promise<'created' | 'added'> {
  if (fs.existsSync(dir)) {
    await c.client.run(['add', '--parents', '--force', '--depth', 'empty', '--', pegSafe(dir)], o(c));
    return 'added';
  }
  await c.client.run(['mkdir', '--parents', '--', pegSafe(dir)], o(c));
  return 'created';
}

/**
 * The file/folder was already renamed on disk (VS Code Explorer): put it back, then let svn do the move so
 * history is kept. On failure the new name is restored.
 */
export async function recordMove(c: WcCtx, from: string, to: string): Promise<void> {
  if (!fs.existsSync(to)) throw new Error(`"${to}" does not exist.`);
  if (fs.existsSync(from)) throw new Error(`"${from}" exists again; nothing to record.`);
  if (!fs.existsSync(path.dirname(from))) throw new Error(`The old folder "${path.dirname(from)}" no longer exists; record the move from a parent folder.`);
  await fsp.rename(to, from);
  try {
    await c.client.run(['add', '--parents', '--force', '--depth', 'empty', '--', pegSafe(path.dirname(to))], o(c)).catch(() => undefined);
    await c.client.run(['move', '--parents', '--', pegSafe(from), pegSafe(to)], o(c));
  } catch (e) {
    if (fs.existsSync(from) && !fs.existsSync(to)) await fsp.rename(from, to).catch(() => undefined);
    throw e;
  }
}

/** True when `p` is a versioned item that is missing on disk (`!`). */
export async function isMissing(c: WcCtx, p: string): Promise<boolean> {
  if (fs.existsSync(p)) return false;
  try {
    const e = (await statusEntries(c, p)).find((x) => path.resolve(x.path).toLowerCase() === path.resolve(p).toLowerCase());
    return e?.item === 'missing';
  } catch {
    return false;
  }
}

export async function isUnversionedPath(c: WcCtx, p: string): Promise<boolean> {
  if (!fs.existsSync(p)) return false;
  try {
    const e = (await statusEntries(c, p)).find((x) => path.resolve(x.path).toLowerCase() === path.resolve(p).toLowerCase());
    return e?.item === 'unversioned';
  } catch {
    return false;
  }
}

async function* walkFiles(dir: string, budget: { left: number }): AsyncGenerator<string> {
  for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
    if (d.name === '.svn') continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) yield* walkFiles(full, budget);
    else if (budget.left-- > 0) yield full;
  }
}

const sha1 = (b: Buffer): string => createHash('sha1').update(b).digest('hex');

export interface MissingScan {
  plan: { moves: Array<{ from: string; to: string }>; deletes: string[] };
  /** Missing folders can only be deleted (or moved from the Explorer rename event). */
  missingDirs: string[];
}

/** Collects `!` files and unversioned files under `target` with content hashes, ready for `pairMoves`. */
export async function scanMissing(c: WcCtx, target: string): Promise<MissingScan> {
  const entries = await statusEntries(c, target);
  const missing = entries.filter((e) => e.item === 'missing');
  const unversioned = entries.filter((e) => e.item === 'unversioned');
  const missingFiles: MissingWithMeta[] = [];
  const missingDirs: string[] = [];
  for (const m of missing) {
    try {
      const r = await c.client.run(['cat', '-r', 'BASE', '--', pegSafe(m.path)], o(c));
      missingFiles.push({ path: m.path, size: r.stdout.length, hash: sha1(r.stdout) });
    } catch {
      missingDirs.push(m.path);
    }
  }
  const fresh: NewItem[] = [];
  if (missingFiles.length) {
    const sizes = new Set(missingFiles.map((m) => m.size));
    const budget = { left: 5000 };
    for (const u of unversioned) {
      const files = isDirSafe(u.path) ? walkFiles(u.path, budget) : (async function* () { yield u.path; })();
      for await (const f of files) {
        const st = await fsp.stat(f);
        if (sizes.has(st.size)) fresh.push({ path: f, size: st.size, hash: sha1(await fsp.readFile(f)) });
      }
    }
  }
  const plan = pairMoves(missingFiles, fresh);
  plan.deletes.push(...missingDirs);
  return { plan, missingDirs };
}

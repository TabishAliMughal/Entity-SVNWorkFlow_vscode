import { existsSync, statSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { SvnRunOptions, pegSafe } from '../svn/client';
import { SvnError } from '../svn/errors';
import { RunResult } from '../svn/runner';
import { StatusEntry, parseStatus } from '../svn/xml';
import { Logger, nullLogger } from '../util/logger';
import { assertUnder } from '../util/safePath';
import { splitTargets } from '../util/targets';
import {
  BackupEntry,
  EntryKind,
  MESSAGE_NAME,
  PlanEntry,
  backupFilePath,
  copyBytes,
  createBackup,
  deleteBackup,
  markCompleted,
  planEntries,
  pruneCommitted,
  readManifest,
  toAbs,
  verifyBackup,
  writeManifest,
} from './backup';

/** The subset of SvnClient the flow needs; tests wrap it to inject failures. */
export interface SvnLike {
  run(args: readonly string[], opts?: SvnRunOptions): Promise<RunResult>;
}

export type FlowStep = 'backup' | 'reset' | 'restore' | 'commit';

export class NothingToOverrideError extends Error {
  constructor(target: string) {
    super(`"${path.basename(target) || target}" has no local changes to commit, so there is nothing to override the server with.`);
    this.name = 'NothingToOverrideError';
  }
}

/** Thrown for every failure after the local content was backed up. The backup folder is always kept. */
export class OverrideError extends Error {
  constructor(
    public readonly step: FlowStep,
    public readonly backupDir: string,
    /** True when the working copy holds the local content again (restored over the updated files). */
    public readonly localRestored: boolean,
    public readonly cause: unknown,
  ) {
    super(
      `Override and Commit failed during "${step}": ${cause instanceof Error ? cause.message : String(cause)}. ` +
        `Your local changes are safe in the backup folder: ${backupDir}. ` +
        (localRestored
          ? 'The working copy contains your local changes again (updated to the latest server revision); nothing was committed.'
          : 'The working copy may be incomplete; run "SVN: Restore from Override Backup" to put your changes back.'),
    );
    this.name = 'OverrideError';
  }
}

export interface OverrideOptions {
  svn: SvnLike;
  repoName: string;
  serverUrl?: string;
  wcRoot: string;
  /** Absolute file, folder or the working copy root. */
  target: string;
  message: string;
  backupRoot: string;
  /** Committed backups to keep (0 = delete right after a successful commit). */
  keepBackups: number;
  signal?: AbortSignal;
  progress?: (message: string) => void;
  logger?: Logger;
  now?: () => Date;
  /** Per-command timeout for the flow (revert/update/commit can be slow). Default: the client's setting. */
  timeoutMs?: number;
  /** Total commit attempts (the flow from revert on is re-run from the backup). Default 2. */
  maxAttempts?: number;
}

export interface OverrideResult {
  /** Undefined when the working copy equalled the server after the restore (nothing to commit). */
  revision?: number;
  backupDir: string;
  backupKept: boolean;
  attempts: number;
  entries: PlanEntry[];
}

export interface Ctx {
  run: (args: readonly string[], opts?: SvnRunOptions) => Promise<RunResult>;
  wcRoot: string;
  log: Logger;
  progress: (m: string) => void;
}

/** A killed/interrupted svn leaves the working copy locked (E155004); svn cleanup clears it. */
const isWcLocked = (e: unknown): boolean => e instanceof SvnError && e.kind === 'locked' && e.codes.includes('E155004');

function makeCtx(svn: SvnLike, repoName: string, wcRoot: string, logger: Logger | undefined, progress: ((m: string) => void) | undefined, timeoutMs?: number): Ctx {
  const log = logger ?? nullLogger;
  const run = async (args: readonly string[], opts?: SvnRunOptions): Promise<RunResult> => {
    const o = { repoName, cwd: wcRoot, timeoutMs, ...opts };
    try {
      return await svn.run(args, o);
    } catch (e) {
      if (args[0] === 'cleanup' || !isWcLocked(e)) throw e;
      log.warn(`Working copy is locked; running svn cleanup and retrying "svn ${args[0]}"`);
      await svn.run(['cleanup', '--', pegSafe(wcRoot)], { repoName, cwd: wcRoot, timeoutMs });
      return svn.run(args, o);
    }
  };
  return {
    run,
    wcRoot,
    log,
    progress: progress ?? (() => undefined),
  };
}

export function kindOf(abs: string): EntryKind {
  try {
    return statSync(abs).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'none';
  }
}

async function localStatus(ctx: Ctx, target: string, signal?: AbortSignal): Promise<StatusEntry[]> {
  const r = await ctx.run(['status', '--', pegSafe(target)], { xml: true, signal });
  return parseStatus(r.text).entries;
}

/** Every local change under the target that Override and Commit will preserve and re-commit. */
export class ConflictsPresentError extends Error {
  constructor(public readonly files: string[]) {
    super(
      `Resolve conflicts first: these files are conflicted or still contain conflict markers, and Override and Commit would commit the markers:\n${files.slice(0, 15).join('\n')}` +
        (files.length > 15 ? `\n... and ${files.length - 15} more` : ''),
    );
    this.name = 'ConflictsPresentError';
  }
}

const MARKERS_MAX_BYTES = 5 * 1024 * 1024;

/** Throws ConflictsPresentError for conflicted entries and for files that still contain merge markers. */
export async function assertNoConflicts(plan: readonly PlanEntry[], wcRoot: string): Promise<void> {
  const bad: string[] = [];
  for (const e of plan) {
    if (e.state === 'deleted') continue;
    if (e.svnStatus === 'conflicted' || e.props === 'conflicted') {
      bad.push(e.rel);
      continue;
    }
    if (e.kind !== 'file') continue;
    try {
      const abs = toAbs(wcRoot, e.rel);
      if ((await fsp.stat(abs)).size > MARKERS_MAX_BYTES) continue;
      const text = (await fsp.readFile(abs)).toString('latin1');
      if (/^<{7}(?: |\r?$)/m.test(text) && /^>{7}(?: |\r?$)/m.test(text)) bad.push(e.rel);
    } catch {
      /* unreadable files are caught by the backup step */
    }
  }
  if (bad.length) throw new ConflictsPresentError(bad);
}

export async function collectLocalChanges(svn: SvnLike, repoName: string, wcRoot: string, target: string, signal?: AbortSignal): Promise<PlanEntry[]> {
  const ctx = makeCtx(svn, repoName, wcRoot, undefined, undefined);
  return planEntries(await localStatus(ctx, target, signal), wcRoot, kindOf);
}

const NO_RETRY = new Set(['auth', 'certificate', 'offline', 'cancelled', 'timeout', 'svnNotFound', 'notWorkingCopy', 'parse']);

function retryable(e: unknown): boolean {
  return !(e instanceof SvnError && NO_RETRY.has(e.kind));
}

async function captureProps(ctx: Ctx, plan: readonly PlanEntry[], wcRoot: string): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  for (const e of plan) {
    if (e.state === 'deleted' || e.kind === 'none') continue;
    if (!(e.props === 'modified' || e.state === 'added' || e.state === 'moved')) continue;
    const abs = toAbs(wcRoot, e.rel);
    const list = await ctx.run(['proplist', '-q', '--', pegSafe(abs)], { allowFailure: true });
    if (list.exitCode !== 0) continue;
    const names = list.text.split(/\r?\n/).filter((l) => /^\s{2,}\S/.test(l)).map((l) => l.trim()).filter((n) => n !== 'svn:mergeinfo');
    const values: Record<string, string> = {};
    for (const name of names) {
      const v = await ctx.run(['propget', '--strict', '--', name, pegSafe(abs)], { allowFailure: true });
      if (v.exitCode === 0) values[name] = v.stdout.toString('base64');
    }
    if (Object.keys(values).length) out.set(e.rel, values);
  }
  return out;
}

async function cleanupAndRevert(ctx: Ctx, target: string): Promise<void> {
  await ctx.run(['revert', '-R', '--quiet', '--', pegSafe(target)]);
}

/** Step 3: svn revert -R, svn update to HEAD, then resolve any conflict in favour of the working file. */
async function resetToHead(ctx: Ctx, target: string): Promise<void> {
  ctx.progress('Reverting local changes');
  await cleanupAndRevert(ctx, target);
  ctx.progress('Updating to the latest server revision');
  await ctx.run(['update', '--force', '--accept', 'postpone', '--quiet', '--', pegSafe(target)]);
  const left = (await localStatus(ctx, target)).filter((e) => e.item === 'conflicted' || e.treeConflicted);
  if (left.length) {
    ctx.log.info(`Resolving ${left.length} conflict(s) after update in favour of the local side`);
    await ctx.run(['resolve', '-R', '--accept', 'working', '--quiet', '--', pegSafe(target)]);
  }
}

const key = (p: string): string => path.normalize(p).toLowerCase();

/**
 * Step 4: puts the backed-up local state back on top of the (updated) working copy: moves, content, adds,
 * deletes and properties. Also used by the restore command, where the working copy can be in any state.
 */
export async function restoreLocalState(ctx: Ctx, entries: readonly BackupEntry[], backupDir: string, target: string): Promise<void> {
  const wc = ctx.wcRoot;
  const unversioned = (await localStatus(ctx, target)).filter((e) => e.item === 'unversioned').map((e) => key(path.resolve(wc, e.path)));
  const underUnversioned = (abs: string): boolean => unversioned.some((u) => key(abs) === u || key(abs).startsWith(u + path.sep));

  const sorted = [...entries].sort((a, b) => a.rel.split('/').length - b.rel.split('/').length);
  const movedOk = new Set<string>();
  const handledDelete = new Set<string>();
  const fallbackAdd = new Set<string>();

  ctx.progress('Restoring renamed items');
  for (const e of sorted.filter((x) => x.state === 'moved')) {
    const abs = toAbs(wc, e.rel);
    const from = e.movedFrom ? toAbs(wc, e.movedFrom) : undefined;
    let ok = false;
    if (from && existsSync(from)) {
      // Leftover of the reverted local add; its bytes are in the verified backup.
      if (existsSync(abs) && underUnversioned(abs)) await fsp.rm(assertUnder(abs, wc, 'restore target'), { recursive: true, force: true });
      if (!existsSync(abs)) {
        const r = await ctx.run(['move', '--quiet', '--', pegSafe(from), pegSafe(abs)], { allowFailure: true });
        ok = r.exitCode === 0;
        if (!ok) ctx.log.warn(`svn move ${e.movedFrom} -> ${e.rel} failed; replaying as delete + add`);
      }
    }
    if (ok) {
      movedOk.add(e.rel);
      if (e.movedFrom) handledDelete.add(e.movedFrom);
    } else {
      fallbackAdd.add(e.rel);
    }
  }

  ctx.progress('Restoring local content');
  const addShallow: string[] = [];
  const addDeep: string[] = [];
  for (const e of sorted) {
    if (e.state === 'deleted' || e.kind === 'none') continue;
    const abs = toAbs(wc, e.rel);
    const existed = existsSync(abs);
    const needsAdd = e.state === 'added' || fallbackAdd.has(e.rel) || (e.state === 'modified' && (!existed || underUnversioned(abs)));
    if (e.kind === 'file') {
      await copyBytes(backupFilePath(backupDir, e.rel), abs);
    } else {
      await fsp.mkdir(abs, { recursive: true });
      for (const f of e.files ?? []) await copyBytes(backupFilePath(backupDir, f.rel), toAbs(wc, f.rel));
    }
    if (needsAdd) (e.recursive ? addDeep : addShallow).push(abs);
  }

  const addBatch = async (paths: string[], depth: string[]): Promise<void> => {
    if (!paths.length) return;
    const list = path.join(backupDir, 'add-targets.txt');
    const { listed, inline } = splitTargets(paths.map(pegSafe));
    if (listed.length) await fsp.writeFile(list, listed.join('\n'), 'utf8');
    await ctx.run(['add', '--force', '--parents', '--quiet', ...depth, ...(listed.length ? ['--targets', list] : []), ...(inline.length ? ['--', ...inline] : [])]);
  };
  ctx.progress('Re-applying local adds');
  await addBatch(addShallow, ['--depth', 'empty']);
  await addBatch(addDeep, []);

  ctx.progress('Re-applying local deletes');
  const deletedDirs: string[] = [];
  for (const e of sorted.filter((x) => x.state === 'deleted')) {
    if (handledDelete.has(e.rel) || deletedDirs.some((d) => e.rel.startsWith(`${d}/`))) continue;
    const abs = toAbs(wc, e.rel);
    if (!existsSync(abs)) continue;
    const r = await ctx.run(['delete', '--force', '--quiet', '--', pegSafe(abs)], { allowFailure: true });
    if (r.exitCode !== 0 && existsSync(abs)) throw new SvnError('unknown', `Could not re-apply the local delete of ${e.rel}: ${r.stderr.trim()}`, r.exitCode, r.stderr);
    deletedDirs.push(e.rel);
  }

  const propFile = path.join(backupDir, 'propvalue.tmp');
  for (const e of sorted) {
    if (e.state === 'deleted' || !e.propValues) continue;
    const abs = toAbs(wc, e.rel);
    if (!existsSync(abs)) continue;
    for (const [name, b64] of Object.entries(e.propValues)) {
      await fsp.writeFile(propFile, Buffer.from(b64, 'base64'));
      await ctx.run(['propset', '--quiet', '--file', propFile, '--', name, pegSafe(abs)]);
    }
  }
  await fsp.rm(propFile, { force: true });
}

async function commitTarget(ctx: Ctx, target: string, messageFile: string): Promise<number | undefined> {
  ctx.progress('Committing');
  const r = await ctx.run(['commit', '--encoding', 'UTF-8', '-F', messageFile, '--', pegSafe(target)]);
  const m = /Committed revision (\d+)/.exec(r.text);
  return m ? Number(m[1]) : undefined;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SvnError('cancelled', 'Cancelled');
}

/**
 * Override and Commit engine (D2): backup -> revert -> update -> restore local state -> commit -> drop backup.
 * Cancelling is honoured only up to the end of the backup; from the revert on the flow runs to a safe end.
 */
export async function overrideAndCommit(o: OverrideOptions): Promise<OverrideResult> {
  const ctx = makeCtx(o.svn, o.repoName, o.wcRoot, o.logger, o.progress, o.timeoutMs);
  const now = o.now ?? (() => new Date());

  ctx.progress('Reading local changes');
  const plan = planEntries(await localStatus(ctx, o.target, o.signal), o.wcRoot, kindOf);
  if (!plan.length) throw new NothingToOverrideError(o.target);
  await assertNoConflicts(plan, o.wcRoot);
  throwIfAborted(o.signal);

  ctx.progress('Backing up local content');
  const props = await captureProps(ctx, plan, o.wcRoot);
  const { dir: backupDir, manifest } = await createBackup({
    backupRoot: o.backupRoot,
    repoName: o.repoName,
    serverUrl: o.serverUrl,
    wcRoot: o.wcRoot,
    target: o.target,
    message: o.message,
    entries: plan,
    propValues: props,
    now: now(),
  });
  ctx.log.info(`Override backup created: ${backupDir} (${plan.length} item(s))`);
  if (o.signal?.aborted) {
    await deleteBackup(backupDir);
    throw new SvnError('cancelled', 'Cancelled');
  }

  const attemptsMax = Math.max(1, o.maxAttempts ?? 2);
  let step: FlowStep = 'reset';
  let localRestored = true;
  let attempt = 0;
  let revision: number | undefined;
  for (;;) {
    attempt++;
    try {
      localRestored = false;
      step = 'reset';
      await resetToHead(ctx, o.target);
      step = 'restore';
      await restoreLocalState(ctx, manifest.entries, backupDir, o.target);
      localRestored = true;
      step = 'commit';
      revision = await commitTarget(ctx, o.target, path.join(backupDir, MESSAGE_NAME));
      break;
    } catch (e) {
      ctx.log.error(`Override attempt ${attempt} failed at ${step}: ${e instanceof Error ? e.message : String(e)}`);
      if (step === 'commit' && attempt < attemptsMax && retryable(e)) {
        ctx.progress('Commit rejected; retrying from the backup');
        continue;
      }
      if (!localRestored) {
        try {
          await restoreLocalState(ctx, manifest.entries, backupDir, o.target);
          localRestored = true;
        } catch (re) {
          ctx.log.error(`Automatic restore failed: ${re instanceof Error ? re.message : String(re)}`);
        }
      }
      throw new OverrideError(step, backupDir, localRestored, e);
    }
  }

  let kept = true;
  try {
    await markCompleted(backupDir, revision, now());
    const keep = Math.max(0, o.keepBackups);
    await pruneCommitted(o.backupRoot, keep);
    kept = keep > 0;
  } catch (e) {
    ctx.log.warn(`Backup cleanup failed (backup kept): ${e instanceof Error ? e.message : String(e)}`);
  }
  return { revision, backupDir, backupKept: kept, attempts: attempt, entries: plan };
}

/** Restore from Override Backup: verifies the backup, then re-applies its local state to the working copy. */
export async function restoreFromBackup(o: { svn: SvnLike; repoName: string; wcRoot: string; backupDir: string; logger?: Logger; progress?: (m: string) => void; timeoutMs?: number }): Promise<{ items: number }> {
  const ctx = makeCtx(o.svn, o.repoName, o.wcRoot, o.logger, o.progress, o.timeoutMs);
  ctx.progress('Verifying backup');
  const manifest = await verifyBackup(o.backupDir);
  const target = toAbs(o.wcRoot, manifest.targetRel);
  await restoreLocalState(ctx, manifest.entries, o.backupDir, target);
  const fresh = await readManifest(o.backupDir);
  fresh.restoredAt = new Date().toISOString();
  await writeManifest(o.backupDir, fresh);
  return { items: manifest.entries.length };
}

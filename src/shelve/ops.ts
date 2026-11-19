import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fetchContent } from '../compare/fetch';
import { buildPatch, collectChanges, planEntry, posixRel, type PatchEntry } from '../patch/create';
import { isSameOrUnder } from '../incoming/model';
import { assertNoLocalIgnored, currentLocalIgnoreList, isLocalIgnored } from '../localignore/model';
import { runPatch } from '../patch/ops';
import { applyFilePatch, parseUnifiedDiff, PatchApplyError } from '../patch/parse';
import type { RepoEntry } from '../repos/model';
import type { SvnClient } from '../svn/client';
import { SvnError } from '../svn/errors';
import { pegSafe } from '../svn/client';
import { assertUnder } from '../util/safePath';
import { withTempFile } from '../util/tempFile';
import { withTargetArgs } from '../util/targets';
import { NATIVE_ENV_VALUES, ShelfFile, ShelfInfo, ShelfMeta, ShelveMode, Backend, isUnknownCommand, parseNativeList, resolveBackend, validateShelfName } from './model';
import type { ShelfStore } from './store';

export interface ShelfCtx {
  client: SvnClient;
  repo: RepoEntry;
  store: ShelfStore;
  tmpDir: string;
  mode: ShelveMode;
  context: number;
  signal?: AbortSignal;
  log?: (msg: string) => void;
  /** Called with the binary files that have local changes and would be replaced by the shelved copy. Default: keep them. */
  confirmOverwrite?: (rels: string[]) => Promise<boolean>;
}

interface Probe {
  env?: NodeJS.ProcessEnv;
  reason?: string;
}

let probeCache: { key: string; probe: Probe } | undefined;
export function resetNativeProbe(): void {
  probeCache = undefined;
}

const errText = (e: unknown): string => (e instanceof SvnError ? `${e.message} ${e.stderr}` : e instanceof Error ? e.message : String(e));

/** Finds the `SVN_EXPERIMENTAL_COMMANDS` value under which `svn x-shelf-list` works (svn 1.14: shelf3). */
export async function probeNative(c: Pick<ShelfCtx, 'client' | 'repo' | 'signal'>): Promise<Probe> {
  const key = c.repo.localFolder;
  if (probeCache?.key === key) return probeCache.probe;
  let reason = 'svn x-shelf-list is not available';
  for (const v of NATIVE_ENV_VALUES) {
    try {
      await c.client.run(['x-shelf-list'], { repoName: c.repo.name, cwd: c.repo.localFolder, env: { SVN_EXPERIMENTAL_COMMANDS: v }, signal: c.signal });
      const probe = { env: { SVN_EXPERIMENTAL_COMMANDS: v } };
      probeCache = { key, probe };
      return probe;
    } catch (e) {
      if (e instanceof SvnError && e.kind === 'cancelled') throw e;
      reason = errText(e).split('\n')[0];
      if (!isUnknownCommand(errText(e))) break;
    }
  }
  const probe = { reason };
  probeCache = { key, probe };
  return probe;
}

const nativeRun = async (c: ShelfCtx, probe: Probe, args: string[]): Promise<string> =>
  (await c.client.run(args, { repoName: c.repo.name, cwd: c.repo.localFolder, env: probe.env, signal: c.signal, timeoutMs: 5 * 60_000 })).text;

export async function listShelves(c: ShelfCtx): Promise<ShelfInfo[]> {
  const out: ShelfInfo[] = [];
  for (const m of await c.store.list(c.repo.name)) out.push({ name: m.name, backend: 'patch', message: m.message, when: m.createdAt, fileCount: m.files.length });
  if (c.mode !== 'patch') {
    const probe = await probeNative(c);
    if (probe.env) {
      try {
        for (const n of parseNativeList(await nativeRun(c, probe, ['x-shelf-list']))) {
          out.push({ name: n.name, backend: 'native', message: n.message, when: n.age ? `${n.age} ago` : undefined, fileCount: n.paths ?? 0, broken: n.broken });
        }
      } catch (e) {
        c.log?.(`Native shelf list failed: ${errText(e)}`);
      }
    }
  }
  return out;
}

export async function nameTaken(c: ShelfCtx, name: string): Promise<boolean> {
  return (await listShelves(c)).some((s) => s.name.toLowerCase() === name.toLowerCase());
}

export interface ShelveInput {
  name: string;
  message: string;
  /** Absolute files/folders; the working copy root means everything. */
  paths: string[];
}

export interface ShelveResult {
  backend: Backend;
  files: string[];
  notes: string[];
}

/** Drops ignored targets; a folder that holds listed paths becomes its individual changed files. */
async function skipLocalIgnored(c: ShelfCtx, paths: readonly string[]): Promise<string[]> {
  const list = currentLocalIgnoreList();
  const kept = paths.filter((p) => !isLocalIgnored(p, list));
  if (!list.some((l) => kept.some((p) => isSameOrUnder(l, p)))) return kept;
  // shortcut: folder property changes are not shelved in this expanded case; collectChanges drops ignored files.
  return (await collectChanges(c.client, c.repo, kept, c.signal)).filter((e) => !e.isDir && e.item !== 'unversioned').map((e) => e.path);
}

export async function shelve(c: ShelfCtx, input: ShelveInput): Promise<ShelveResult> {
  const bad = validateShelfName(input.name);
  if (bad) throw new Error(bad);
  if (await nameTaken(c, input.name)) throw new Error(`A shelf named "${input.name}" already exists.`);
  const paths = await skipLocalIgnored(c, input.paths);
  if (!paths.length) throw new Error('Nothing to shelve: everything selected is on the Local Ignore List.');
  input = { ...input, paths };
  const probe = c.mode === 'patch' ? ({} as Probe) : await probeNative(c);
  const backend = resolveBackend(c.mode, !!probe.env);
  const notes: string[] = [];
  if (backend === 'native') {
    try {
      return await nativeShelve(c, probe, input);
    } catch (e) {
      if (c.mode === 'native' || (e instanceof SvnError && e.kind === 'cancelled')) throw e;
      notes.push(`Native shelving failed (${errText(e).split('\n')[0].trim()}); used the patch fallback instead.`);
      c.log?.(notes[0]);
      await nativeRun(c, probe, ['x-shelf-drop', input.name]).catch(() => undefined);
    }
  }
  const r = await patchShelve(c, input);
  r.notes.unshift(...notes);
  return r;
}

async function nativeShelve(c: ShelfCtx, probe: Probe, input: ShelveInput): Promise<ShelveResult> {
  const rels = input.paths.map((p) => posixRel(c.repo.localFolder, p)).filter((r) => r && r !== '.').map((r) => (r.startsWith('-') ? `./${r}` : r));
  const run = (extra: string[]): Promise<string> => nativeRun(c, probe, ['x-shelve', ...extra, input.name, ...rels.map(pegSafe)]);
  const text = input.message.trim() ? await withTempFile(c.tmpDir, input.message, (f) => run(['-F', f])) : await run([]);
  if (!new RegExp(`shelved '${input.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`).test(text)) throw new Error(`svn x-shelve did not confirm the shelf: ${text.trim().split('\n').pop() ?? ''}`);
  return { backend: 'native', files: rels, notes: ['Native svn shelving is experimental in svn 1.14.'] };
}

async function patchShelve(c: ShelfCtx, input: ShelveInput): Promise<ShelveResult> {
  const { client, repo } = c;
  const all = await collectChanges(client, repo, input.paths, c.signal);
  const notes: string[] = [];
  const chosen: PatchEntry[] = [];
  for (const e of all) {
    const plan = planEntry(e);
    const rel = posixRel(repo.localFolder, e.path);
    if (plan.how === 'skip') {
      if (plan.reason !== 'unchanged' && !/unversioned|folder/.test(plan.reason)) notes.push(`Not shelved: ${rel} (${plan.reason})`);
      continue;
    }
    if (e.isDir && plan.how === 'svn') {
      notes.push(`Not shelved: ${rel} (folder property changes)`);
      continue;
    }
    if (e.copied || e.moved || e.item === 'replaced') {
      notes.push(`Not shelved: ${rel} (copy, move or replace)`);
      continue;
    }
    chosen.push(e);
  }
  if (!chosen.length) throw new Error('There are no shelvable changes in the selection (unversioned files, copies, moves and folders are not shelved).');

  const built = await buildPatch(client, repo, chosen, { context: c.context, binary: 'omit', signal: c.signal });
  const binary = new Set(built.binary);
  const files: ShelfFile[] = chosen.map((e) => {
    const rel = posixRel(repo.localFolder, e.path);
    return { path: rel, status: e.item === 'added' ? 'added' : e.item === 'deleted' ? 'deleted' : 'modified', binary: binary.has(rel) };
  });
  const binaries = new Map<string, string>();
  for (const f of files) if (f.binary && f.status !== 'deleted') binaries.set(f.path, path.join(repo.localFolder, ...f.path.split('/')));
  const meta: ShelfMeta = { format: 1, name: input.name, message: input.message, createdAt: new Date().toISOString(), repoName: repo.name, files };
  await c.store.write(meta, built.bytes, binaries);

  assertNoLocalIgnored(chosen.map((e) => e.path));
  // Everything is stored; now take the changes out of the working copy.
  await withTargetArgs(c.tmpDir, chosen.map((e) => pegSafe(e.path)), (tail) => client.run(['revert', ...tail], { repoName: repo.name, cwd: repo.localFolder, signal: c.signal }));
  for (const e of chosen) {
    if (e.item === 'added') await fs.rm(assertUnder(e.path, repo.localFolder), { force: true });
  }
  if (built.viaSvn.length) notes.push(`${built.viaSvn.length} file(s) were stored through svn diff --git: ${built.viaSvn.map((v) => `${v.path} (${v.reason})`).join(', ')}`);
  return { backend: 'patch', files: files.map((f) => f.path), notes };
}

export interface UnshelveResult {
  backend: Backend;
  /** Files with rejected hunks or conflicts. */
  conflicts: string[];
  rejects: string[];
  dropped: boolean;
  notes: string[];
}

/** Working-copy files the shelf touches that already have local changes. */
export async function dirtyTargets(c: ShelfCtx, info: ShelfInfo): Promise<string[]> {
  if (info.backend === 'native') return [];
  const meta = await c.store.read(c.repo.name, info.name);
  const out: string[] = [];
  for (const f of meta.files) {
    const abs = assertUnder(path.join(c.repo.localFolder, ...f.path.split('/')), c.repo.localFolder, 'shelf path');
    const st = await c.client.status(abs, { repoName: c.repo.name, cwd: c.repo.localFolder, signal: c.signal }).catch(() => ({ entries: [] }));
    if (st.entries.some((e) => path.normalize(e.path).toLowerCase() === path.normalize(abs).toLowerCase() && (e.item !== 'normal' || e.props === 'modified'))) out.push(f.path);
  }
  return out;
}

export async function unshelve(c: ShelfCtx, info: ShelfInfo, o: { drop: boolean }): Promise<UnshelveResult> {
  const res: UnshelveResult = { backend: info.backend, conflicts: [], rejects: [], dropped: false, notes: [] };
  if (info.backend === 'native') {
    const probe = await probeNative(c);
    if (!probe.env) throw new Error('Native shelving is not available in this svn.');
    const text = await nativeRun(c, probe, ['x-unshelve', info.name]);
    res.conflicts = text.split(/\r?\n/).filter((l) => /^C[ C]?\s/.test(l)).map((l) => l.replace(/^C[ C]?\s+/, '').trim());
    if (o.drop && !res.conflicts.length) {
      try {
        await dropNative(c, probe, info.name);
        res.dropped = true;
      } catch (e) {
        res.notes.push(`Unshelved, but the shelf could not be deleted (${errText(e).split('\n')[0]}). Delete it again later.`);
      }
    }
    return res;
  }
  const meta = await c.store.read(c.repo.name, info.name);
  const patch = await c.store.readPatch(c.repo.name, info.name);
  if (patch.length) {
    const r = await runPatch({ client: c.client, repo: c.repo, cwd: c.repo.localFolder, signal: c.signal }, { patchFile: c.store.patchPath(c.repo.name, info.name) });
    res.conflicts = r.outcome.conflicts;
    res.rejects = r.rejects;
    if (r.outcome.skipped.length) res.notes.push(`Skipped (target missing): ${r.outcome.skipped.join(', ')}`);
  }
  const rc = { repoName: c.repo.name, cwd: c.repo.localFolder, signal: c.signal };
  const binaries = meta.files.filter((x) => x.binary).map((f) => ({ f, abs: assertUnder(path.join(c.repo.localFolder, ...f.path.split('/')), c.repo.localFolder, 'shelf path') }));
  const keep = new Set<string>();
  const risky: typeof binaries = [];
  for (const b of binaries) {
    const local = await fs.readFile(b.abs).catch(() => undefined);
    if (!local) continue;
    const shelved = b.f.status === 'deleted' ? undefined : await fs.readFile(c.store.filePath(c.repo.name, info.name, b.f.path)).catch(() => undefined);
    if (shelved && local.equals(shelved)) continue;
    const st = await c.client.status(b.abs, { repoName: c.repo.name, cwd: c.repo.localFolder, signal: c.signal }).catch(() => ({ entries: [] }));
    const mine = st.entries.find((e) => path.normalize(path.resolve(c.repo.localFolder, e.path)).toLowerCase() === path.normalize(b.abs).toLowerCase());
    // svn status lists nothing for an unmodified versioned file
    if (mine && (mine.item !== 'normal' || mine.props === 'modified')) risky.push(b);
  }
  if (risky.length) {
    // Binaries cannot be merged: keep a copy of what is there before it may be replaced.
    const saved = path.join(c.store.dir(c.repo.name, info.name), 'overwritten', new Date().toISOString().replace(/[-:]/g, '').slice(0, 15));
    for (const b of risky) {
      const dest = path.join(saved, ...b.f.path.split('/'));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(b.abs, dest);
    }
    const ok = c.confirmOverwrite ? await c.confirmOverwrite(risky.map((b) => b.f.path)) : false;
    if (ok) res.notes.push(`Local versions of ${risky.length} binary file(s) were replaced; copies are in ${saved}`);
    else {
      for (const b of risky) {
        keep.add(b.f.path);
        res.conflicts.push(b.f.path);
      }
      res.notes.push(`Kept your local version of: ${risky.map((b) => b.f.path).join(', ')} (not overwritten; the shelf was kept). Copies are in ${saved}`);
    }
  }
  for (const { f, abs } of binaries) {
    if (keep.has(f.path)) continue;
    if (f.status === 'deleted') {
      await c.client.run(['delete', '--force', '--', pegSafe(abs)], rc);
      continue;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.copyFile(c.store.filePath(c.repo.name, info.name, f.path), abs);
    if (f.status === 'added') await c.client.run(['add', '--force', '--', pegSafe(abs)], rc);
  }
  if (o.drop && !res.conflicts.length) {
    await c.store.delete(c.repo.name, info.name);
    res.dropped = true;
  }
  return res;
}

async function dropNative(c: ShelfCtx, probe: Probe, name: string): Promise<void> {
  // Windows can hold the shelf's wc.db for a moment after svn exits.
  for (let i = 0; ; i++) {
    try {
      await nativeRun(c, probe, ['x-shelf-drop', name]);
      return;
    } catch (e) {
      if (i >= 2) throw e;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
}

export async function deleteShelf(c: ShelfCtx, info: ShelfInfo): Promise<void> {
  if (info.backend === 'patch') return c.store.delete(c.repo.name, info.name);
  const probe = await probeNative(c);
  if (!probe.env) throw new Error('Native shelving is not available in this svn.');
  await dropNative(c, probe, info.name);
}

export interface ShelfPreviewFile {
  path: string;
  status: 'modified' | 'added' | 'deleted';
  binary: boolean;
  /** Current BASE text (empty for added files) and the text with the shelved change applied. */
  baseText?: string;
  shelvedText?: string;
  /** Why no text is available (binary, or the file changed since shelving). */
  error?: string;
}

/** The shelved files as BASE vs shelved text, for the compare view. */
export async function previewShelf(c: ShelfCtx, info: ShelfInfo): Promise<ShelfPreviewFile[]> {
  let diffText: string;
  let meta: ShelfMeta | undefined;
  if (info.backend === 'native') {
    const probe = await probeNative(c);
    if (!probe.env) throw new Error('Native shelving is not available in this svn.');
    diffText = await nativeRun(c, probe, ['x-shelf-diff', info.name]);
  } else {
    meta = await c.store.read(c.repo.name, info.name);
    diffText = (await c.store.readPatch(c.repo.name, info.name)).toString('utf8');
  }
  const out: ShelfPreviewFile[] = [];
  for (const fp of parseUnifiedDiff(diffText)) {
    const abs = path.join(c.repo.localFolder, ...fp.path.split('/'));
    const status = fp.isNew ? 'added' : fp.isDelete ? 'deleted' : 'modified';
    const item: ShelfPreviewFile = { path: fp.path, status, binary: fp.binary };
    if (fp.binary) item.error = 'Binary file';
    else {
      try {
        const base = fp.isNew ? '' : (await fetchContent(c.client, { repoName: c.repo.name, target: abs, rev: 'BASE' }, c.signal)).text;
        item.baseText = base;
        item.shelvedText = fp.isDelete ? '' : applyFilePatch(base, fp);
      } catch (e) {
        item.error = e instanceof PatchApplyError ? 'The file changed since it was shelved; the shelved hunks no longer match BASE.' : errText(e);
      }
    }
    out.push(item);
  }
  for (const f of meta?.files.filter((x) => x.binary) ?? []) out.push({ path: f.path, status: f.status, binary: true, error: 'Binary file (stored as a copy)' });
  return out;
}

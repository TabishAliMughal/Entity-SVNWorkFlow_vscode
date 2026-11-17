import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { decodeContent } from '../compare/content';
import { fetchContent } from '../compare/fetch';
import type { RepoEntry } from '../repos/model';
import { pegSafe, type SvnClient } from '../svn/client';
import type { StatusEntry } from '../svn/xml';
import { unifiedFileDiff } from './unified';

export interface PatchEntry {
  /** Absolute path. */
  path: string;
  item: string;
  props: string;
  copied?: boolean;
  moved?: boolean;
  treeConflicted?: boolean;
  isDir: boolean;
  revision?: number;
}

export type Plan = { how: 'engine' | 'svn' } | { how: 'skip'; reason: string };

const UNREPRESENTABLE: Record<string, string> = {
  unversioned: 'unversioned (run Add first)',
  missing: 'missing from disk',
  conflicted: 'in conflict',
  obstructed: 'obstructed',
  incomplete: 'incomplete',
  external: 'external',
  ignored: 'ignored',
};

/** Which generator handles an entry. Our engine covers plain text edits, adds and deletes; everything else is `svn diff --git`. */
export function planEntry(e: Pick<PatchEntry, 'item' | 'props' | 'copied' | 'moved' | 'treeConflicted' | 'isDir'>): Plan {
  if (e.treeConflicted) return { how: 'skip', reason: 'tree conflict' };
  const bad = UNREPRESENTABLE[e.item];
  if (bad) return { how: 'skip', reason: bad };
  const propsChanged = e.props === 'modified' || e.props === 'conflicted';
  if (e.isDir) return propsChanged ? { how: 'svn' } : { how: 'skip', reason: 'folder add/delete is not part of a patch' };
  if (e.copied || e.moved || e.item === 'replaced') return { how: 'svn' };
  if (propsChanged) return { how: 'svn' };
  if (e.item === 'modified' || e.item === 'added' || e.item === 'deleted') return { how: 'engine' };
  return { how: 'skip', reason: 'unchanged' };
}

export interface BuildOptions {
  context: number;
  /** `svn`: binary files go through `svn diff --git` (svn patch cannot carry them); `omit`: leave them out and list them. */
  binary: 'svn' | 'omit';
  signal?: AbortSignal;
}

export interface BuildResult {
  bytes: Buffer;
  /** Relative paths written by our engine. */
  engine: string[];
  /** Relative paths written by `svn diff --git`, with the reason. */
  viaSvn: Array<{ path: string; reason: string }>;
  /** Binary files (omitted, or included through svn when binary is `svn`). */
  binary: string[];
  skipped: Array<{ path: string; reason: string }>;
}

export const posixRel = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');

export function toPatchEntry(e: StatusEntry, isDir: boolean): PatchEntry {
  return { path: e.path, item: e.item, props: e.props, copied: e.copied, moved: !!e.movedFrom || !!e.movedTo, treeConflicted: e.treeConflicted, isDir, revision: e.revision };
}

/** Changed entries under the given paths (svn status), de-duplicated, sorted by path. Unversioned and other unrepresentable ones are included so callers can report them. */
export async function collectChanges(client: SvnClient, repo: RepoEntry, paths: readonly string[], signal?: AbortSignal): Promise<PatchEntry[]> {
  const seen = new Map<string, PatchEntry>();
  for (const p of paths) {
    const { entries } = await client.status(p, { repoName: repo.name, cwd: repo.localFolder, signal });
    for (const e of entries) {
      const key = path.normalize(e.path).toLowerCase();
      if (seen.has(key)) continue;
      const isDir = await fs.stat(e.path).then((s) => s.isDirectory(), () => false);
      seen.set(key, toPatchEntry(e, isDir));
    }
  }
  return [...seen.values()].filter((e) => e.item !== 'normal' || e.props === 'modified' || e.props === 'conflicted').sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
}

/** Builds one patch from working-copy changes: BASE -> working, paths relative to `repo.localFolder`. */
export async function buildPatch(client: SvnClient, repo: RepoEntry, entries: readonly PatchEntry[], o: BuildOptions): Promise<BuildResult> {
  const res: BuildResult = { bytes: Buffer.alloc(0), engine: [], viaSvn: [], binary: [], skipped: [] };
  const parts: Array<{ rel: string; text: string }> = [];
  const svnPaths: string[] = [];
  const toSvn = (rel: string, reason: string): void => {
    svnPaths.push(rel);
    res.viaSvn.push({ path: rel, reason });
  };
  for (const e of entries) {
    const rel = posixRel(repo.localFolder, e.path);
    const plan = planEntry(e);
    if (plan.how === 'skip') {
      if (plan.reason !== 'unchanged') res.skipped.push({ path: rel, reason: plan.reason });
      continue;
    }
    if (plan.how === 'svn') {
      toSvn(rel, e.props === 'modified' || e.props === 'conflicted' ? 'property changes' : 'copy/move/replace');
      continue;
    }
    const fetchBase = (): ReturnType<typeof fetchContent> => fetchContent(client, { repoName: repo.name, target: e.path, rev: 'BASE' }, o.signal);
    const oldC = e.item === 'added' ? undefined : await fetchBase();
    const raw = e.item === 'deleted' ? undefined : await fs.readFile(e.path);
    const newC = raw ? decodeContent(raw, oldC?.mime) : undefined;
    if (oldC?.binary || newC?.binary) {
      res.binary.push(rel);
      if (o.binary === 'svn') toSvn(rel, 'binary file');
      continue;
    }
    if ((oldC && oldC.encoding !== 'utf-8') || (newC && newC.encoding !== 'utf-8')) {
      toSvn(rel, `${(oldC ?? newC)?.encoding} text (not re-encoded)`);
      continue;
    }
    const oldText = oldC?.text ?? '';
    const newText = newC?.text ?? '';
    const text = unifiedFileDiff(rel, oldText, newText, {
      context: o.context,
      oldLabel: e.item === 'added' ? '(nonexistent)' : `(revision ${e.revision ?? 0})`,
      newLabel: e.item === 'deleted' ? '(nonexistent)' : '(working copy)',
    });
    if (!text) {
      // Empty added/deleted files have no hunks; svn still writes the header that creates or removes them.
      if (e.item === 'added' || e.item === 'deleted') toSvn(rel, 'empty file');
      continue;
    }
    parts.push({ rel, text });
    res.engine.push(rel);
  }
  const chunks: Buffer[] = parts.map((p) => Buffer.from(p.text, 'utf8'));
  if (svnPaths.length) {
    const args = ['diff', '--git', '--internal-diff', '--', ...svnPaths.map((p) => pegSafe(p.startsWith('-') ? `./${p}` : p))];
    const r = await client.run(args, { repoName: repo.name, cwd: repo.localFolder, signal: o.signal });
    if (r.stdout.length) {
      const info = await client.info(repo.localFolder, { repoName: repo.name, cwd: repo.localFolder, signal: o.signal });
      chunks.push(Buffer.from(rewriteGitPaths(r.stdout.toString('latin1'), repoRelativePrefix(info.url, info.repositoryRoot)), 'latin1'));
    }
  }
  res.bytes = Buffer.concat(chunks);
  return res;
}

/** Path of the working copy root below the repository root, `a/b/` form ('' at the root). svn prints this prefix in `--git` headers. */
export function repoRelativePrefix(wcUrl: string, repoRoot: string): string {
  const rel = wcUrl.replace(/\/+$/, '').slice(repoRoot.replace(/\/+$/, '').length).replace(/^\/+/, '');
  if (!rel) return '';
  const dec = rel.split('/').map((seg) => {
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  });
  return `${dec.join('/')}/`;
}

/**
 * svn 1.14 writes `a/<repo-root-relative path>` in `--git` headers, which `svn patch` cannot map back onto a working copy.
 * Strips that prefix from the header lines (the patch body is untouched; the text is a latin1 view so bytes survive).
 */
export function rewriteGitPaths(diff: string, prefix: string): string {
  if (!prefix) return diff;
  return diff
    .split('\n')
    .map((line) => {
      if (/^(diff --git |--- |\+\+\+ )/.test(line)) return line.split(`a/${prefix}`).join('a/').split(`b/${prefix}`).join('b/');
      if (line.startsWith('Property changes on: ')) return line.replace(`: ${prefix}`, ': ');
      return line;
    })
    .join('\n');
}

export function describeBuild(r: BuildResult): string {
  const bits = [`${r.engine.length} file(s) from the extension's diff engine`];
  if (r.viaSvn.length) bits.push(`${r.viaSvn.length} through \`svn diff --git\` (${[...new Set(r.viaSvn.map((v) => v.reason))].join(', ')})`);
  if (r.skipped.length) bits.push(`${r.skipped.length} skipped (${[...new Set(r.skipped.map((v) => v.reason))].join(', ')})`);
  return bits.join('; ');
}

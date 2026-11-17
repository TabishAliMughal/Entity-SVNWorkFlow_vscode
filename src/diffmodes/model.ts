import * as path from 'node:path';
import type { Layout } from '../branch/model';
import type { Source } from '../compare/sources';
import type { Rev } from '../compare/fetch';
import { parseXml } from '../svn/xml';

/** Folder / repo level diff modes. File level modes build their two sources directly (see `fileSources`). */
export type FolderMode =
  | { mode: 'base' }
  | { mode: 'head' }
  | { mode: 'rev'; rev: number }
  | { mode: 'urls'; oldUrl: string; oldRev: Rev; newUrl: string; newRev: Rev };

const trimUrl = (u: string): string => u.replace(/\/+$/, '');

/** `svn diff --summarize` arguments listing the changed files of a mode. `target` is the working-copy folder (use with cwd). */
export function summarizeArgs(m: FolderMode, target = '.'): string[] {
  switch (m.mode) {
    case 'base':
      return ['diff', '--summarize', '--', target];
    case 'head':
      return ['diff', '--summarize', '-r', 'HEAD', '--', target];
    case 'rev':
      return ['diff', '--summarize', '-r', String(m.rev), '--', target];
    case 'urls':
      return ['diff', '--summarize', '--old', `${trimUrl(m.oldUrl)}@${m.oldRev}`, '--new', `${trimUrl(m.newUrl)}@${m.newRev}`];
  }
}

export interface SummaryEntry {
  item: string;
  props: string;
  kind: string;
  /** Relative to the compared root. Local modes: plain path; URL mode: as printed (URL-encoded). */
  rel: string;
}

/** Parses `svn diff --summarize --xml`. */
export function parseDiffSummary(xml: string, m: FolderMode): SummaryEntry[] {
  const doc = parseXml(xml);
  const raw = doc?.diff?.paths;
  const list: unknown[] = raw && typeof raw === 'object' ? ((raw as { path?: unknown[] }).path ?? []) : [];
  // svn prints URL summaries under the --old URL.
  const roots = m.mode === 'urls' ? [trimUrl(m.oldUrl), trimUrl(m.newUrl)] : [];
  const out: SummaryEntry[] = [];
  for (const p of list as Array<Record<string, string> | string>) {
    const text = typeof p === 'string' ? p : String(p['#text'] ?? '');
    const a = typeof p === 'string' ? ({} as Record<string, string>) : p;
    let rel = text.trim();
    if (m.mode === 'urls') {
      const root = roots.find((r) => rel.toLowerCase().startsWith(r.toLowerCase()));
      if (root) rel = rel.slice(root.length).replace(/^\/+/, '');
    } else rel = rel.replace(/\\/g, '/');
    out.push({ item: a['@_item'] ?? 'modified', props: a['@_props'] ?? 'none', kind: a['@_kind'] ?? 'file', rel });
  }
  return out;
}

const empty = (name: string, label: string): Source => ({ kind: 'text', text: '', name, label });

export interface PairedSources {
  left: Source;
  right: Source;
  editableSide?: 'left' | 'right';
}

/**
 * Left/right sources for one changed file of a folder diff. Local modes follow the existing pane conventions:
 * working copy is always left (editable); BASE / server / revision on the right.
 */
export function pairFor(m: FolderMode, repoName: string, root: string, e: SummaryEntry): PairedSources {
  const name = e.rel.split('/').pop() || e.rel;
  if (m.mode === 'urls') {
    const dec = (u: string): string => `${trimUrl(u)}/${e.rel}`;
    const side = (u: string, r: Rev, gone: boolean, which: string): Source =>
      gone ? empty(name, `${which} (does not exist)`) : { kind: 'rev', repoName, target: `${dec(u)}@${r}`, rev: r, label: `${which} @${r}` };
    return { left: side(m.oldUrl, m.oldRev, e.item === 'added', shortUrl(m.oldUrl)), right: side(m.newUrl, m.newRev, e.item === 'deleted', shortUrl(m.newUrl)) };
  }
  const abs = path.resolve(root, e.rel);
  const local = (gone: boolean): Source => (gone ? empty(name, 'Working copy (deleted)') : { kind: 'local', fsPath: abs, repoName });
  if (m.mode === 'base') {
    const base: Source = e.item === 'added' ? empty(name, 'BASE (does not exist)') : { kind: 'rev', repoName, target: abs, rev: 'BASE', label: 'BASE (last update)' };
    return { left: local(e.item === 'deleted'), right: base, editableSide: 'left' };
  }
  const rev: Rev = m.mode === 'head' ? 'HEAD' : m.rev;
  const server: Source = e.item === 'added' ? empty(name, 'Server (does not exist)') : { kind: 'rev', repoName, target: abs, rev, label: rev === 'HEAD' ? 'Server HEAD' : `Revision ${rev}` };
  return { left: local(e.item === 'deleted'), right: server, editableSide: 'left' };
}

/** The same working-copy path at `rev` on the server, for two-revision file compares. `url@rev` pins the peg so renamed or deleted paths resolve. */
export function revSource(repoName: string, url: string, rev: Rev, label?: string): Source {
  return { kind: 'rev', repoName, target: `${trimUrl(url)}@${rev}`, rev, label: label ?? `r${rev}` };
}

export function modeTitle(m: FolderMode, name: string): string {
  switch (m.mode) {
    case 'base':
      return `${name}: Working Copy vs BASE`;
    case 'head':
      return `${name}: Working Copy vs HEAD`;
    case 'rev':
      return `${name}: Working Copy vs r${m.rev}`;
    case 'urls':
      return `${name}: ${shortUrl(m.oldUrl)}@${m.oldRev} vs ${shortUrl(m.newUrl)}@${m.newRev}`;
  }
}

function shortUrl(u: string): string {
  return trimUrl(u).split('/').slice(-2).join('/');
}

/** URL of the trunk / branch / tag directory a URL lives in, or undefined for URLs outside the standard layout. */
export function refRootOf(layout: Layout): string | undefined {
  if (layout.kind === 'trunk') return layout.trunk;
  if (layout.kind === 'branch' && layout.name) return `${layout.branches}/${layout.name}`;
  if (layout.kind === 'tag' && layout.name) return `${layout.tags}/${layout.name}`;
  return undefined;
}

/** `wcUrl` re-rooted onto another trunk/branch/tag URL: the same path in the other branch. */
export function samePathIn(wcUrl: string, layout: Layout, otherRef: string): string | undefined {
  const cur = refRootOf(layout);
  const u = trimUrl(wcUrl);
  if (!cur || !u.toLowerCase().startsWith(cur.toLowerCase())) return undefined;
  return trimUrl(otherRef) + u.slice(cur.length);
}

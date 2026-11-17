/** Pure helpers for repository layout (trunk/branches/tags) and ref names. No vscode, no svn calls. */
import { joinSvnUrl } from '../util/svnUrl';

export interface LayoutSettings {
  /** Project base relative to the repo root; empty = detect from the working copy URL. */
  base?: string;
  trunk: string;
  branches: string;
  tags: string;
}

export const DEFAULT_LAYOUT: LayoutSettings = { trunk: 'trunk', branches: 'branches', tags: 'tags' };

export type RefKind = 'trunk' | 'branch' | 'tag';

export interface Layout {
  root: string;
  /** Base URL (root + base path), no trailing slash. */
  base: string;
  trunk: string;
  branches: string;
  tags: string;
  /** What the inspected URL is. */
  kind: RefKind | 'other';
  /** Branch or tag name when kind is branch/tag. */
  name?: string;
}

const trimSlashes = (s: string): string => s.replace(/^\/+|\/+$/g, '');
const segs = (s: string): string[] => trimSlashes(s).split('/').filter(Boolean);
const startsWith = (a: string[], b: string[]): boolean => b.length > 0 && b.length <= a.length && b.every((x, i) => a[i] === x);

/** Classifies the part of a URL below the project base. */
function classify(rest: string[], s: LayoutSettings): { kind: Layout['kind']; name?: string } {
  const t = segs(s.trunk);
  const b = segs(s.branches);
  const g = segs(s.tags);
  if (startsWith(rest, t)) return { kind: 'trunk' };
  if (startsWith(rest, b) && rest.length > b.length) return { kind: 'branch', name: rest[b.length] };
  if (startsWith(rest, g) && rest.length > g.length) return { kind: 'tag', name: rest[g.length] };
  return { kind: 'other' };
}

/**
 * Finds the project base of `url` below `root`: the first path position from which trunk/branches/tags
 * follow. Without a match the repo root is the base (standard layout at the root).
 */
export function detectLayout(root: string, url: string, settings: Partial<LayoutSettings> = {}): Layout {
  const s: LayoutSettings = { ...DEFAULT_LAYOUT };
  for (const k of ['base', 'trunk', 'branches', 'tags'] as const) {
    const v = settings[k];
    if (v !== undefined && trimSlashes(v) !== '') s[k] = trimSlashes(v);
  }
  const r = root.replace(/\/+$/, '');
  const u = url.replace(/\/+$/, '');
  const rel = u.toLowerCase().startsWith(r.toLowerCase()) ? segs(u.slice(r.length)) : [];
  let baseSegs: string[] = [];
  if (s.base) baseSegs = segs(s.base);
  else {
    for (let i = 0; i < rel.length; i++) {
      if (classify(rel.slice(i), s).kind !== 'other') {
        baseSegs = rel.slice(0, i);
        break;
      }
    }
  }
  const rest = startsWith(rel, baseSegs) || baseSegs.length === 0 ? rel.slice(baseSegs.length) : [];
  const c = classify(rest, s);
  const base = baseSegs.length ? `${r}/${baseSegs.join('/')}` : r;
  return { root: r, base, trunk: `${base}/${trimSlashes(s.trunk)}`, branches: `${base}/${trimSlashes(s.branches)}`, tags: `${base}/${trimSlashes(s.tags)}`, kind: c.kind, name: c.name };
}

export function refUrl(layout: Layout, kind: 'branch' | 'tag', name: string): string {
  return joinSvnUrl(kind === 'branch' ? layout.branches : layout.tags, trimSlashes(name));
}

/** Message for an invalid branch/tag name, undefined when fine. Nested names (feature/x) are allowed. */
export function validateRefName(name: string): string | undefined {
  const n = name.trim();
  if (!n) return 'Enter a name.';
  if (n !== name) return 'No leading or trailing spaces.';
  if (/^\/|\/$|\/\//.test(n)) return 'No leading, trailing or doubled slashes.';
  if (n.split('/').some((p) => p === '.' || p === '..')) return 'No "." or ".." segments.';
  if (/[\\:*?"<>|@#%]/.test(n) || [...n].some((ch) => ch.charCodeAt(0) < 32)) return 'Characters \\ : * ? " < > | @ # % are not allowed.';
  return undefined;
}

export function defaultMessage(kind: 'branch' | 'tag', name: string, source: string): string {
  return `Create ${kind} ${name} from ${source}`;
}

export type CopySource = { kind: 'wc'; path: string } | { kind: 'url'; url: string; rev: number | 'HEAD' };

/** svn copy arguments for creating a ref; the message file is passed with -F, never -m. */
export function buildCopyArgs(src: CopySource, destUrl: string, msgFile: string): string[] {
  const args = ['copy', '--parents', '-F', msgFile, '--encoding', 'UTF-8'];
  if (src.kind === 'url' && src.rev !== 'HEAD') args.push('-r', String(src.rev));
  args.push('--', src.kind === 'wc' ? src.path : src.rev === 'HEAD' ? src.url : `${src.url}@${src.rev}`, destUrl);
  return args;
}

export function parseCommitted(text: string): number | undefined {
  const m = /Committed revision (\d+)/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

import type { LogEntry } from '../svn/xml';

export interface LogFilter {
  author?: string;
  /** Inclusive local dates, YYYY-MM-DD. */
  dateFrom?: string;
  dateTo?: string;
  revFrom?: number;
  revTo?: number;
  /** Case-insensitive substring of the commit message. */
  text?: string;
  /** Case-insensitive substring of any changed path. */
  path?: string;
  stopOnCopy?: boolean;
}

export const DEFAULT_PAGE_SIZE = 50;
/** Revisions scanned per page request when client-side filters thin the results. */
export const SCAN_BATCH = 200;
export const MAX_SCAN_BATCHES = 10;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDate(s: string | undefined): s is string {
  return !!s && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00`));
}

export function hasClientFilter(f: LogFilter): boolean {
  return !!(f.author?.trim() || f.text?.trim() || f.path?.trim());
}

/** Validates user input; returns a message or undefined. */
export function validateFilter(f: LogFilter): string | undefined {
  if (f.dateFrom && !isDate(f.dateFrom)) return 'From date must look like 2025-01-31.';
  if (f.dateTo && !isDate(f.dateTo)) return 'To date must look like 2025-01-31.';
  if (f.dateFrom && f.dateTo && f.dateFrom > f.dateTo) return 'From date is after To date.';
  for (const r of [f.revFrom, f.revTo]) if (r !== undefined && (!Number.isInteger(r) || r < 0)) return 'Revisions must be whole numbers.';
  if (f.revFrom !== undefined && f.revTo !== undefined && f.revFrom > f.revTo) return 'From revision is greater than To revision.';
  return undefined;
}

/** Newest and oldest bound of the server-side `-r` range. A revision bound wins over a date bound. */
export function rangeBounds(f: LogFilter): { top: string; bottom: string } {
  const top = f.revTo !== undefined ? String(f.revTo) : f.dateTo ? `{${f.dateTo}T23:59:59}` : 'HEAD';
  const bottom = f.revFrom !== undefined ? String(f.revFrom) : f.dateFrom ? `{${f.dateFrom}T00:00:00}` : '1';
  return { top, bottom };
}

/** `svn log` arguments for one batch below `cursorRev` (exclusive: only revisions < cursor when set). */
export function buildLogArgs(target: string, f: LogFilter, limit: number, cursorRev?: number): string[] {
  const { top, bottom } = rangeBounds(f);
  const args = ['log', '-v', '-r', `${cursorRev !== undefined ? String(cursorRev - 1) : top}:${bottom}`, '--limit', String(limit)];
  if (f.stopOnCopy) args.push('--stop-on-copy');
  args.push('--', target);
  return args;
}

export function matchesFilter(e: LogEntry, f: LogFilter): boolean {
  const a = f.author?.trim().toLowerCase();
  if (a && !(e.author ?? '').toLowerCase().includes(a)) return false;
  const t = f.text?.trim().toLowerCase();
  if (t && !(e.message ?? '').toLowerCase().includes(t)) return false;
  const p = f.path?.trim().toLowerCase();
  if (p && !e.paths.some((x) => x.path.toLowerCase().includes(p))) return false;
  return true;
}

export interface Page {
  entries: LogEntry[];
  /** Pass back as `cursor` for the next page; undefined when history is exhausted. */
  nextCursor?: number;
  scanned: number;
}

export type FetchBatch = (cursorRev: number | undefined, limit: number) => Promise<LogEntry[]>;

/**
 * Collects up to `pageSize` entries matching the client-side filters, scanning batches from the
 * server (newest first). Stops after MAX_SCAN_BATCHES batches; the cursor then lets the caller continue.
 */
export async function loadPage(fetch: FetchBatch, f: LogFilter, pageSize: number, cursor?: number): Promise<Page> {
  const client = hasClientFilter(f);
  const batch = client ? SCAN_BATCH : pageSize;
  const entries: LogEntry[] = [];
  let cur = cursor;
  let scanned = 0;
  let exhausted = false;
  for (let i = 0; i < (client ? MAX_SCAN_BATCHES : 1); i++) {
    if (cur !== undefined && (cur <= 1 || (f.revFrom !== undefined && cur - 1 < f.revFrom))) {
      exhausted = true;
      break;
    }
    let got = await fetch(cur, batch);
    // A numeric start below a date lower bound makes svn walk the range upwards: that means we crossed the bound.
    if (got.length > 1 && got[0].revision < got[got.length - 1].revision) {
      got = [];
      exhausted = true;
    }
    scanned += got.length;
    let lastIndex = got.length;
    for (let k = 0; k < got.length; k++) {
      if (!matchesFilter(got[k], f)) continue;
      entries.push(got[k]);
      if (entries.length >= pageSize) {
        lastIndex = k + 1;
        break;
      }
    }
    if (got.length) cur = got[lastIndex - 1].revision;
    if (exhausted || (got.length < batch && lastIndex === got.length)) {
      exhausted = true;
      break;
    }
    if (entries.length >= pageSize) break;
  }
  const lowestBound = f.revFrom;
  if (!exhausted && cur !== undefined && lowestBound !== undefined && cur <= lowestBound) exhausted = true;
  if (cur !== undefined && cur <= 1) exhausted = true;
  return { entries, nextCursor: exhausted ? undefined : cur, scanned };
}

/** URL-encode a repository path segment-wise (keeps '/'). */
export function encodeRepoPath(p: string): string {
  return p
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

export function repoPathToUrl(root: string, repoPath: string): string {
  return root.replace(/\/+$/, '') + encodeRepoPath(repoPath);
}

/** Unified-diff-free summary line for pickers: `r12 alice 2025-01-02  first line`. */
export function summarizeEntry(e: LogEntry): string {
  const first = (e.message ?? '').split(/\r?\n/)[0];
  return `r${e.revision} ${e.author ?? '?'} ${(e.date ?? '').slice(0, 10)}  ${first}`;
}

/** Pure merge helpers: revision specs, svn merge/mergeinfo output parsing, argument building. */
import { parseUpdateConflicts } from '../ops/targets';

export type MergeKind = 'sync' | 'reintegrate' | 'range';
export const ACCEPT_POLICIES = ['postpone', 'mine-conflict', 'theirs-conflict', 'mine-full', 'theirs-full', 'base'] as const;
export type AcceptPolicy = (typeof ACCEPT_POLICIES)[number];

export interface MergeSpec {
  kind: MergeKind;
  source: string;
  target: string;
  /** For kind 'range': normalized `-c` argument such as `5,7,9-11`. */
  revs?: string;
  dryRun?: boolean;
  recordOnly?: boolean;
  ignoreAncestry?: boolean;
  accept?: AcceptPolicy;
}

/** `svn mergeinfo --show-revs` output ("r12" per line) -> sorted unique revision numbers. */
export function parseRevList(text: string): number[] {
  const out = new Set<number>();
  for (const l of text.split(/\r?\n/)) {
    const m = /^\s*r?(\d+)\s*$/.exec(l);
    if (m) out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

export type RevSpecResult = { spec: string; revs: number[] } | { error: string };

/** "5", "5-9", "5, 7, 9-11", "r5 r7" -> `5,7,9-11` (sorted, merged, ranges kept). */
export function parseRevSpec(input: string): RevSpecResult {
  const parts = input.split(/[\s,;]+/).map((p) => p.replace(/^r/i, '')).filter(Boolean);
  if (!parts.length) return { error: 'Enter a revision, a range (5-9) or a list (5,7,9-11).' };
  const set = new Set<number>();
  for (const p of parts) {
    const m = /^(\d+)(?:[-:](\d+))?$/.exec(p);
    if (!m) return { error: `"${p}" is not a revision or range.` };
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a < 1 || b < a) return { error: `"${p}" is not a valid range (use low-high, from 1).` };
    if (b - a > 100_000) return { error: `"${p}" spans too many revisions.` };
    for (let r = a; r <= b; r++) set.add(r);
  }
  const revs = [...set].sort((x, y) => x - y);
  return { spec: compressRevs(revs), revs };
}

/** [5,7,9,10,11] -> "5,7,9-11" */
export function compressRevs(revs: readonly number[]): string {
  const s = [...new Set(revs)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i ? `${s[i]}-${s[j]}` : String(s[i]));
    i = j + 1;
  }
  return out.join(',');
}

export function buildMergeArgs(m: MergeSpec): string[] {
  const args = ['merge'];
  if (m.dryRun) args.push('--dry-run');
  if (m.recordOnly) args.push('--record-only');
  if (m.ignoreAncestry) args.push('--ignore-ancestry');
  if (m.kind === 'range') {
    if (!m.revs) throw new Error('A revision range merge needs revisions.');
    args.push('-c', m.revs);
  }
  args.push('--accept', m.accept ?? 'postpone', '--', m.source, m.target);
  return args;
}

export interface MergeChange {
  /** First column: A D U G C E R (blank for property-only changes). */
  action: string;
  /** Second column: property status. */
  props: string;
  path: string;
}

export interface MergeResult {
  changes: MergeChange[];
  conflicts: string[];
  skipped: string[];
  recordedMergeinfo: boolean;
}

const CHANGE_RE = /^([ADUGCER ])([ UGC])([ LB])([ C]) ?(\S.*)$/;

/** Parses `svn merge` output: touched paths, conflicts, skipped paths. */
export function parseMergeOutput(text: string): MergeResult {
  const changes: MergeChange[] = [];
  const skipped: string[] = [];
  const resolved = new Set<string>();
  let recording = false;
  let recorded = false;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/\s+$/, '');
    if (/^--- Recording mergeinfo/i.test(l)) {
      recording = true;
      continue;
    }
    if (/^--- /.test(l)) {
      recording = false;
      continue;
    }
    const rs = /^Resolved conflicted state of '(.+)'$/.exec(l);
    if (rs) {
      resolved.add(rs[1]);
      continue;
    }
    const sk = /^Skipped(?: missing target)?:? '?(.+?)'?(?: --.*)?$/.exec(l);
    if (sk) {
      skipped.push(sk[1]);
      continue;
    }
    const m = CHANGE_RE.exec(l);
    if (!m) continue;
    if (recording) {
      recorded = true;
      continue;
    }
    changes.push({ action: m[1], props: m[2], path: m[5] });
  }
  return { changes, // --accept mine-*/theirs-*/base prints `C path` and then "Resolved conflicted state".
    conflicts: [...new Set(parseUpdateConflicts(text))].filter((c) => !resolved.has(c)), skipped, recordedMergeinfo: recorded };
}

export function summarizeMerge(r: MergeResult): string {
  const n = (f: (c: MergeChange) => boolean): number => r.changes.filter(f).length;
  const parts: string[] = [];
  const add = (count: number, label: string): void => {
    if (count) parts.push(`${count} ${label}`);
  };
  add(n((c) => c.action === 'A'), 'added');
  add(n((c) => c.action === 'D'), 'deleted');
  add(n((c) => c.action === 'U' || c.action === 'R' || (c.action === ' ' && c.props === 'U')), 'updated');
  add(n((c) => c.action === 'G' || c.props === 'G'), 'merged');
  add(r.conflicts.length, r.conflicts.length === 1 ? 'conflict' : 'conflicts');
  add(r.skipped.length, 'skipped');
  return parts.length ? parts.join(', ') : r.recordedMergeinfo ? 'mergeinfo recorded only' : 'no changes';
}

/** Eligible revisions (newest first), each paired with its log entry when the log has it. */
export function eligibleEntries<T extends { revision: number }>(eligible: readonly number[], log: readonly T[]): Array<T | { revision: number }> {
  const byRev = new Map(log.map((e) => [e.revision, e]));
  return [...eligible].sort((a, b) => b - a).map((r) => byRev.get(r) ?? { revision: r });
}

/** Path of a merge result entry relative to the merge target (svn prints it as given on the command line). */
export function relToTarget(p: string, target: string): string {
  const norm = (x: string): string => x.replace(/\\/g, '/').replace(/\/+$/, '');
  const a = norm(p);
  const t = norm(target);
  return a.toLowerCase().startsWith(`${t.toLowerCase()}/`) ? a.slice(t.length + 1) : a;
}

export function mergeTitle(m: MergeSpec): string {
  const what = m.kind === 'range' ? `r${m.revs}` : m.kind === 'reintegrate' ? 'reintegrate' : 'sync';
  return `${m.dryRun ? 'Previewing' : 'Merging'} ${what} from ${m.source}`;
}

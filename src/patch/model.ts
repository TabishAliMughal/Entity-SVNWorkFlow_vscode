/** Pure helpers for `svn patch` (argument building and output parsing). */

export interface PatchApplyOptions {
  /** Absolute patch file. */
  patchFile: string;
  dryRun?: boolean;
  reverse?: boolean;
  /** Leading path components to strip from the names in the patch. */
  strip?: number;
}

/** Target paths named in a patch's headers that are absolute or climb out with `..` (svn would resolve them against the working copy). */
export function unsafePatchTargets(patch: string): string[] {
  const bad = new Set<string>();
  const check = (raw: string): void => {
    let p = raw.replace(/\t.*$/, '').trim();
    if (p.length > 1 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    if (!p || p === '/dev/null') return;
    const n = p.replace(/\\/g, '/');
    if (n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..')) bad.add(p);
  };
  for (const line of patch.split(/\r?\n/)) {
    let m: RegExpExecArray | null;
    if ((m = /^(?:---|\+\+\+) (.*)$/.exec(line))) check(m[1]);
    else if ((m = /^Index: (.*)$/.exec(line))) check(m[1]);
    else if ((m = /^(?:rename|copy) (?:from|to) (.*)$/.exec(line))) check(m[1]);
    else if ((m = /^diff --git (.*)$/.exec(line))) for (const part of m[1].split(/ (?=[ab]\/)/)) check(part);
  }
  return [...bad];
}

export function buildPatchArgs(o: PatchApplyOptions): string[] {
  const a = ['patch'];
  if (o.dryRun) a.push('--dry-run');
  if (o.reverse) a.push('--reverse-diff');
  if (o.strip && o.strip > 0) a.push('--strip', String(Math.floor(o.strip)));
  a.push('--', o.patchFile);
  return a;
}

export interface PatchOutcomeEntry {
  /** svn action letter: A added, D deleted, U updated, G merged, C conflict (rejected hunks), E existed. */
  action: string;
  /** Path relative to the folder `svn patch` ran in. */
  path: string;
  /** Detail lines (`> applied hunk ... with offset`, `> rejected hunk`). */
  notes: string[];
}

export interface PatchOutcome {
  entries: PatchOutcomeEntry[];
  /** Targets named in the patch that do not exist locally. */
  skipped: string[];
  conflicts: string[];
  rejectedHunks: number;
}

const ENTRY = /^([ADUCGEMR ])([ADUCGEMR ])\s+(.+?)\s*$/;

export function parsePatchOutput(text: string): PatchOutcome {
  const out: PatchOutcome = { entries: [], skipped: [], conflicts: [], rejectedHunks: 0 };
  let cur: PatchOutcomeEntry | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    const skipped = /^Skipped missing target: '(.+)'$/.exec(line);
    if (skipped) {
      out.skipped.push(skipped[1]);
      cur = undefined;
      continue;
    }
    if (line.startsWith('>')) {
      const note = line.slice(1).trim();
      cur?.notes.push(note);
      if (/^rejected hunk/.test(note)) out.rejectedHunks++;
      continue;
    }
    const m = ENTRY.exec(line);
    if (m && (m[1] !== ' ' || m[2] !== ' ')) {
      cur = { action: (m[1] + m[2]).trim(), path: m[3], notes: [] };
      out.entries.push(cur);
      if (m[1] === 'C' || m[2] === 'C') out.conflicts.push(m[3]);
    }
  }
  return out;
}

export const REJECT_SUFFIX = '.svnpatch.rej';

/** Removes the first `n` path components, as `svn patch --strip n` does. */
export function stripPath(p: string, n: number): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(Math.max(0, n)).join('/');
}

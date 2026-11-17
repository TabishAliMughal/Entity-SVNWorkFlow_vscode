import { diffLines, splitLines, type DiffOptions, type Hunk, type Line } from '../diff';

export interface UnifiedOptions {
  /** Context lines around each change. Default 3. */
  context?: number;
  /** Text after the tab on the `---` line, e.g. `(revision 12)` or `(nonexistent)`. */
  oldLabel?: string;
  newLabel?: string;
  /** Engine options. Default exact: anything else drops differences, so the patch no longer reproduces the file. */
  diff?: DiffOptions;
}

const RULE = '='.repeat(67);

function range(start: number, count: number): string {
  if (count === 0) return `${start},0`;
  return count === 1 ? `${start + 1}` : `${start + 1},${count}`;
}

function render(prefix: string, l: Line): string {
  return l.eol === '' ? `${prefix}${l.text}\n\\ No newline at end of file\n` : `${prefix}${l.text}${l.eol}`;
}

/** Hunk bodies (`@@ ... @@` plus lines) for old -> new, in svn's unified format. Empty string when nothing differs. */
export function unifiedHunks(oldText: string, newText: string, o: UnifiedOptions = {}): string {
  const ctx = Math.max(0, Math.floor(o.context ?? 3));
  const res = diffLines(oldText, newText, o.diff ?? {});
  if (!res.hunks.length) return '';
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const groups: Hunk[][] = [];
  for (const h of res.hunks) {
    const g = groups[groups.length - 1];
    if (g && h.localStart - g[g.length - 1].localEnd <= 2 * ctx) g.push(h);
    else groups.push([h]);
  }
  let out = '';
  for (const g of groups) {
    const oldStart = Math.max(0, g[0].localStart - ctx);
    const oldEnd = Math.min(oldLines.length, g[g.length - 1].localEnd + ctx);
    const newStart = g[0].incomingStart - (g[0].localStart - oldStart);
    let body = '';
    let pos = oldStart;
    let minus = 0;
    let plus = 0;
    for (const h of g) {
      for (; pos < h.localStart; pos++) body += render(' ', oldLines[pos]);
      for (let i = h.localStart; i < h.localEnd; i++) body += render('-', oldLines[i]);
      for (let i = h.incomingStart; i < h.incomingEnd; i++) body += render('+', newLines[i]);
      minus += h.localEnd - h.localStart;
      plus += h.incomingEnd - h.incomingStart;
      pos = h.localEnd;
    }
    for (; pos < oldEnd; pos++) body += render(' ', oldLines[pos]);
    const oldCount = oldEnd - oldStart;
    out += `@@ -${range(oldStart, oldCount)} +${range(newStart, oldCount - minus + plus)} @@\n${body}`;
  }
  return out;
}

/** A complete per-file section with svn's `Index:` / `===` headers, ready for `svn patch`. Empty string when identical. */
export function unifiedFileDiff(relPath: string, oldText: string, newText: string, o: UnifiedOptions = {}): string {
  const p = relPath.replace(/\\/g, '/');
  const hunks = unifiedHunks(oldText, newText, o);
  if (!hunks) return '';
  return `Index: ${p}\n${RULE}\n--- ${p}\t${o.oldLabel ?? '(revision 0)'}\n+++ ${p}\t${o.newLabel ?? '(working copy)'}\n${hunks}`;
}

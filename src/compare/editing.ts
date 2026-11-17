/** Pure text-editing helpers shared by the compare webview (optimistic model) and the extension (undo history). */

export interface Pos {
  line: number;
  col: number;
}

export const TAB_SIZE = 4;

export function comparePos(a: Pos, b: Pos): number {
  return a.line - b.line || a.col - b.col;
}

/** Position right after `text` was inserted at `start` (text uses \n). */
export function endPosition(start: Pos, text: string): Pos {
  const i = text.lastIndexOf('\n');
  if (i < 0) return { line: start.line, col: start.col + text.length };
  let n = 0;
  for (let k = text.indexOf('\n'); k >= 0; k = text.indexOf('\n', k + 1)) n++;
  return { line: start.line + n, col: text.length - i - 1 };
}

export function clampPos(lines: readonly string[], p: Pos): Pos {
  const line = Math.max(0, Math.min(p.line, lines.length - 1));
  return { line, col: Math.max(0, Math.min(p.col, (lines[line] ?? '').length)) };
}

/** Replaces [start, end] in `lines` (one entry per document line, no EOLs) in place. */
export function applyEditToLines(lines: string[], start: Pos, end: Pos, text: string): void {
  const head = (lines[start.line] ?? '').slice(0, start.col);
  const tail = (lines[end.line] ?? '').slice(end.col);
  const parts = text.split('\n');
  parts[0] = head + parts[0];
  parts[parts.length - 1] += tail;
  const count = end.line - start.line + 1;
  if (parts.length < 2000) {
    lines.splice(start.line, count, ...parts);
    return;
  }
  const rest = lines.splice(start.line + count);
  lines.length = start.line;
  for (const p of parts) lines.push(p);
  for (const r of rest) lines.push(r);
}

export function textInRange(lines: readonly string[], a: Pos, b: Pos): string {
  if (a.line === b.line) return (lines[a.line] ?? '').slice(a.col, b.col);
  const out = [(lines[a.line] ?? '').slice(a.col)];
  for (let i = a.line + 1; i < b.line; i++) out.push(lines[i] ?? '');
  out.push((lines[b.line] ?? '').slice(0, b.col));
  return out.join('\n');
}

/** Display column of string index `col` (tabs advance to the next tab stop). */
export function visualCol(text: string, col: number, tab = TAB_SIZE): number {
  let v = 0;
  const n = Math.min(col, text.length);
  for (let i = 0; i < n; i++) v = text.charCodeAt(i) === 9 ? v + tab - (v % tab) : v + 1;
  return v + (col - n);
}

/** Nearest string index for display column `v` (rounds to the closer character edge). */
export function colAtVisual(text: string, v: number, tab = TAB_SIZE): number {
  let cur = 0;
  for (let i = 0; i < text.length; i++) {
    const next = text.charCodeAt(i) === 9 ? cur + tab - (cur % tab) : cur + 1;
    if (v < (cur + next) / 2) return i;
    cur = next;
  }
  return text.length;
}

type CharClass = 0 | 1 | 2;
const cls = (ch: string): CharClass => (/\s/.test(ch) ? 0 : /\w/.test(ch) ? 1 : 2);

export function wordLeft(text: string, col: number): number {
  let i = col;
  while (i > 0 && cls(text[i - 1]) === 0) i--;
  if (i === 0) return 0;
  const c = cls(text[i - 1]);
  while (i > 0 && cls(text[i - 1]) === c) i--;
  return i;
}

export function wordRight(text: string, col: number): number {
  let i = col;
  const n = text.length;
  if (i >= n) return n;
  const c = cls(text[i]);
  if (c !== 0) while (i < n && cls(text[i]) === c) i++;
  while (i < n && cls(text[i]) === 0) i++;
  return i;
}

/** Word (or whitespace/punctuation run) around `col`, for double-click selection. */
export function wordAt(text: string, col: number): [number, number] {
  if (!text.length) return [0, 0];
  const at = Math.min(col, text.length - 1);
  const c = cls(text[at]);
  let s = at;
  let e = at;
  while (s > 0 && cls(text[s - 1]) === c) s--;
  while (e < text.length && cls(text[e]) === c) e++;
  return [s, e];
}

export function leadingWhitespace(text: string): string {
  return /^[ \t]*/.exec(text)?.[0] ?? '';
}

/** Shifts the lines [fromLine, toLine] right (`outdent` false) or left; returns the replacement text for those whole lines. */
export function reindent(lines: readonly string[], fromLine: number, toLine: number, outdent: boolean, unit: string): string {
  const out: string[] = [];
  for (let i = fromLine; i <= toLine; i++) {
    const l = lines[i] ?? '';
    if (!outdent) out.push(l.length ? unit + l : l);
    else if (l.startsWith('\t')) out.push(l.slice(1));
    else {
      const m = /^ {1,4}/.exec(l);
      out.push(m ? l.slice(m[0].length) : l);
    }
  }
  return out.join('\n');
}

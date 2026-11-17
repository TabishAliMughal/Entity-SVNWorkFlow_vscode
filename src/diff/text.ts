import type { DiffOptions } from './types';

export interface Line {
  text: string;
  /** '', '\n', '\r\n' or '\r'. '' only on an unterminated last line. */
  eol: string;
}

/** An empty string has zero lines; "a\n" has one line (no phantom empty last line). */
export function splitLines(s: string): Line[] {
  const out: Line[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    let j = i;
    while (j < n && s.charCodeAt(j) !== 10 && s.charCodeAt(j) !== 13) j++;
    let eol = '';
    let next = j;
    if (j < n) {
      if (s.charCodeAt(j) === 13 && j + 1 < n && s.charCodeAt(j + 1) === 10) {
        eol = '\r\n';
        next = j + 2;
      } else {
        eol = s[j];
        next = j + 1;
      }
    }
    out.push({ text: s.slice(i, j), eol });
    i = next;
  }
  return out;
}

export function joinLines(lines: readonly Line[]): string {
  let r = '';
  for (const l of lines) r += l.text + l.eol;
  return r;
}

export function dominantEol(lines: readonly Line[]): string {
  const c: Record<string, number> = { '\n': 0, '\r\n': 0, '\r': 0 };
  for (const l of lines) if (l.eol) c[l.eol]++;
  let best = '\n';
  let bc = 0;
  for (const k of ['\n', '\r\n', '\r']) {
    if (c[k] > bc) {
      best = k;
      bc = c[k];
    }
  }
  return best;
}

export function normalizeText(text: string, ws: DiffOptions['ignoreWhitespace']): string {
  if (ws === 'all') return text.replace(/\s+/g, '');
  if (ws === 'trailing') return text.replace(/[ \t\f\v]+$/, '');
  return text;
}

export function lineKey(line: Line, opts: DiffOptions): string {
  let t = normalizeText(line.text, opts.ignoreWhitespace);
  if (opts.ignoreCase) t = t.toLowerCase();
  return opts.ignoreEol ? t : t + '\u0001' + line.eol;
}

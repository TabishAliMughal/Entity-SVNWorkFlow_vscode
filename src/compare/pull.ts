import { splitLines, joinLines, type DiffOptions, type DiffResult, type Line } from '../diff';
import { dominantEolOf } from './eol';

export interface TextEdit {
  /** UTF-16 offsets into the old text. */
  start: number;
  end: number;
  text: string;
}

/** Smallest single replacement turning `oldText` into `newText`; undefined when equal. */
export function minimalEdit(oldText: string, newText: string): TextEdit | undefined {
  if (oldText === newText) return undefined;
  const max = Math.min(oldText.length, newText.length);
  let p = 0;
  while (p < max && oldText.charCodeAt(p) === newText.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && oldText.charCodeAt(oldText.length - 1 - s) === newText.charCodeAt(newText.length - 1 - s)) s++;
  return { start: p, end: oldText.length - s, text: newText.slice(p, newText.length - s) };
}

/** Result of pulling every hunk of `diff` (computed for exactly `target`/`source`) from source into target, in one pass. */
export function applyAllHunks(target: string, source: string, diff: DiffResult, side: 'local' | 'incoming', opts: DiffOptions = {}): string {
  const t = splitLines(target);
  const s = splitLines(source);
  const eol = dominantEolOf(t);
  const out: Line[] = [];
  for (const b of diff.blocks) {
    const ts = side === 'local' ? b.localStart : b.incomingStart;
    const te = side === 'local' ? b.localEnd : b.incomingEnd;
    const ss = side === 'local' ? b.incomingStart : b.localStart;
    const se = side === 'local' ? b.incomingEnd : b.localEnd;
    if (b.type === 'equal') out.push(...t.slice(ts, te));
    else for (const l of s.slice(ss, se)) out.push({ text: l.text, eol: opts.ignoreEol && l.eol ? eol : l.eol });
  }
  for (let i = 0; i < out.length - 1; i++) if (out[i].eol === '') out[i] = { text: out[i].text, eol };
  return joinLines(out);
}

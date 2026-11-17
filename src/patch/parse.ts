export interface PatchLine {
  op: ' ' | '-' | '+';
  text: string;
  /** '' when the line has no terminator (`\ No newline at end of file`). */
  eol: string;
}

export interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: PatchLine[];
}

export interface FilePatch {
  /** Path as written in the patch (Index: line when present, else the new/old file name). */
  path: string;
  isNew: boolean;
  isDelete: boolean;
  /** Binary marker (`Binary files differ`, `GIT binary patch`, svn's "Cannot display"); no hunks. */
  binary: boolean;
  hunks: PatchHunk[];
}

export class PatchApplyError extends Error {
  constructor(message: string, readonly hunk: number) {
    super(message);
  }
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function cleanName(s: string): string {
  let n = s.replace(/\r$/, '');
  const tab = n.indexOf('\t');
  if (tab >= 0) n = n.slice(0, tab);
  return n.trim();
}

const isNothing = (name: string, label: string): boolean => name === '/dev/null' || /\(nonexistent\)|1970-01-01|1969-12-31/.test(label);

/** Parses an svn or git style unified diff into per-file patches. */
export function parseUnifiedDiff(text: string): FilePatch[] {
  const lines = text.split('\n');
  const out: FilePatch[] = [];
  let cur: FilePatch | undefined;
  let indexPath: string | undefined;
  let i = 0;
  const hl = (n: number): string => (lines[n] ?? '').replace(/\r$/, '');
  const begin = (p: string): FilePatch => {
    cur = { path: p, isNew: false, isDelete: false, binary: false, hunks: [] };
    out.push(cur);
    return cur;
  };
  while (i < lines.length) {
    const l = hl(i);
    if (l.startsWith('Index: ')) {
      indexPath = l.slice(7).trim();
      cur = undefined;
      i++;
    } else if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      indexPath = m ? m[2] : undefined;
      cur = undefined;
      i++;
    } else if (l.startsWith('--- ') && hl(i + 1).startsWith('+++ ')) {
      const rawOld = l.slice(4);
      const rawNew = hl(i + 1).slice(4);
      const oldName = cleanName(rawOld);
      const newName = cleanName(rawNew);
      const strip = (n: string): string => (/^[ab]\//.test(n) ? n.slice(2) : n);
      const f = begin(indexPath ?? strip(isNothing(newName, rawNew) ? oldName : newName));
      f.isNew = isNothing(oldName, rawOld);
      f.isDelete = isNothing(newName, rawNew);
      indexPath = undefined;
      i += 2;
    } else if (cur && HUNK.test(l)) {
      const m = HUNK.exec(l) as RegExpExecArray;
      const h: PatchHunk = { oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4], lines: [] };
      let o = h.oldCount;
      let n = h.newCount;
      i++;
      while (i < lines.length && (o > 0 || n > 0)) {
        const raw = lines[i];
        if (raw.startsWith('\\')) {
          const last = h.lines[h.lines.length - 1];
          if (last) last.eol = '';
          i++;
          continue;
        }
        const blank = raw === '' || raw === '\r';
        const op = blank ? ' ' : raw[0];
        if (op !== ' ' && op !== '-' && op !== '+') break;
        const body = blank ? raw : raw.slice(1);
        const crlf = body.endsWith('\r');
        h.lines.push({ op, text: crlf ? body.slice(0, -1) : body, eol: crlf ? '\r\n' : '\n' });
        if (op !== '+') o--;
        if (op !== '-') n--;
        i++;
      }
      while (i < lines.length && lines[i].startsWith('\\')) {
        const last = h.lines[h.lines.length - 1];
        if (last) last.eol = '';
        i++;
      }
      cur.hunks.push(h);
    } else if (/^(Binary files .* differ|GIT binary patch|Cannot display: file marked as binary type)/.test(l)) {
      const f = cur ?? (indexPath !== undefined ? begin(indexPath) : undefined);
      if (f) f.binary = true;
      i++;
    } else {
      i++;
    }
  }
  return out;
}

function dominantEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? '\r\n' : '\n';
}

function splitKeep(s: string): Array<{ text: string; eol: string }> {
  const out: Array<{ text: string; eol: string }> = [];
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j < s.length && s[j] !== '\n' && s[j] !== '\r') j++;
    let eol = '';
    if (j < s.length) eol = s[j] === '\r' && s[j + 1] === '\n' ? '\r\n' : s[j];
    out.push({ text: s.slice(i, j), eol });
    i = j + eol.length;
  }
  return out;
}

/**
 * Strict apply of one file's hunks (no fuzz; hunks may move by an offset like `svn patch`). Hunk lines are
 * matched by text, so a CRLF file takes an LF patch; added lines adopt the file's dominant EOL.
 */
export function applyFilePatch(oldText: string, fp: FilePatch, opts: { reverse?: boolean } = {}): string {
  const rev = !!opts.reverse;
  const lines = splitKeep(oldText);
  const eol = dominantEol(oldText);
  const from = rev ? '+' : '-';
  let delta = 0;
  fp.hunks.forEach((h, idx) => {
    const expect = h.lines.filter((l) => l.op === ' ' || l.op === from);
    const start = rev ? h.newStart : h.oldStart;
    const count = rev ? h.newCount : h.oldCount;
    const base = count === 0 ? start : start - 1;
    const want = base + delta;
    const at = (p: number): boolean => p >= 0 && p + expect.length <= lines.length && expect.every((e, k) => lines[p + k].text === e.text);
    let pos = -1;
    for (let d = 0; d <= lines.length + 1 && pos < 0; d++) {
      if (at(want - d)) pos = want - d;
      else if (at(want + d)) pos = want + d;
    }
    if (pos < 0) throw new PatchApplyError(`Hunk ${idx + 1} (@@ -${h.oldStart} +${h.newStart} @@) does not match the file`, idx);
    // An LF patch on a CRLF file (or the reverse): new lines take the file's terminator.
    let adopt = expect.length === 0 ? eol : '\n';
    expect.forEach((e, j) => {
      const fe = lines[pos + j].eol;
      if (e.eol && fe && e.eol !== fe) adopt = fe;
    });
    const next: Array<{ text: string; eol: string }> = [];
    let k = 0;
    for (const l of h.lines) {
      if (l.op === ' ') next.push(lines[pos + k++]);
      else if (l.op === from) k++;
      else next.push({ text: l.text, eol: l.eol === '\n' ? adopt : l.eol });
    }
    lines.splice(pos, expect.length, ...next);
    delta = pos - base + (next.length - expect.length);
  });
  return lines.map((l) => l.text + l.eol).join('');
}

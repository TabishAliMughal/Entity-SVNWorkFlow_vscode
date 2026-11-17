/** Helpers turning highlight.js HTML (whole file) into per-line HTML with optional word-level marks. */

type Tok = { t: 'open'; raw: string } | { t: 'close' } | { t: 'text'; s: string };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#x27;'));
}

function tokenize(html: string): Tok[] {
  const out: Tok[] = [];
  const re = /<span[^>]*>|<\/span>|[^<]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const s = m[0];
    if (s.startsWith('</span')) out.push({ t: 'close' });
    else if (s.startsWith('<span')) out.push({ t: 'open', raw: s });
    else out.push({ t: 'text', s });
  }
  return out;
}

/** Splits highlighted HTML at newlines, closing and reopening spans so every line is balanced. */
export function splitHighlighted(html: string): string[] {
  const lines: string[] = [];
  const stack: string[] = [];
  let cur = '';
  for (const tok of tokenize(html)) {
    if (tok.t === 'open') {
      stack.push(tok.raw);
      cur += tok.raw;
    } else if (tok.t === 'close') {
      stack.pop();
      cur += '</span>';
    } else {
      const parts = tok.s.split(/\r\n|\r|\n/);
      parts.forEach((p, i) => {
        if (i > 0) {
          lines.push(cur + '</span>'.repeat(stack.length));
          cur = stack.join('');
        }
        cur += p;
      });
    }
  }
  lines.push(cur + '</span>'.repeat(stack.length));
  return lines;
}

export interface Range {
  start: number;
  end: number;
}

/** Wraps the given plain-text character ranges of one highlighted line in <mark class="w">. Ranges must be sorted, non-overlapping. */
export function markWords(lineHtml: string, ranges: readonly Range[], cls = 'w'): string {
  if (!ranges.length) return lineHtml;
  let out = '';
  let col = 0;
  let ri = 0;
  let inMark = false;
  const open = `<mark class="${cls}">`;
  const setMark = (want: boolean): void => {
    if (want && !inMark) out += open;
    else if (!want && inMark) out += '</mark>';
    inMark = want;
  };
  for (const tok of tokenize(lineHtml)) {
    if (tok.t !== 'text') {
      const was = inMark;
      setMark(false);
      out += tok.t === 'open' ? tok.raw : '</span>';
      if (was) setMark(true);
      continue;
    }
    // Walk decoded characters, but emit the original entities.
    const re = /&(?:amp|lt|gt|quot|#x27|#39);|[\s\S]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tok.s))) {
      while (ri < ranges.length && col >= ranges[ri].end) ri++;
      const inside = ri < ranges.length && col >= ranges[ri].start && col < ranges[ri].end;
      setMark(inside);
      out += m[0];
      col += 1;
    }
  }
  setMark(false);
  return out;
}

const PEG = /@(?:\d+|HEAD|BASE|COMMITTED|PREV|\{[^}]*\})$/i;
const SAFE = /[A-Za-z0-9\-._~!$&'()*+,;=:/]/;

/** Percent-encodes everything in a URL path that svn cannot take literally; existing %XX escapes are kept. */
export function encodeUrlPath(path: string): string {
  let out = '';
  for (let i = 0; i < path.length; ) {
    const cp = path.codePointAt(i) as number;
    const ch = String.fromCodePoint(cp);
    if (ch === '%' && /^%[0-9a-f]{2}/i.test(path.slice(i, i + 3))) {
      out += path.slice(i, i + 3);
      i += 3;
      continue;
    }
    i += ch.length;
    if (ch.length === 1 && SAFE.test(ch)) out += ch;
    else for (const b of Buffer.from(ch, 'utf8')) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * A URL as typed by the user, made safe for svn: spaces, non-ASCII, `#`, `?`, a bare `%` and an `@` inside the path
 * are percent-encoded. A trailing `@REV` (digits, HEAD, BASE, ...) is a peg revision and stays.
 */
export function encodeSvnUrl(input: string): string {
  const t = input.trim();
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)(.*)$/i.exec(t);
  let rest = m ? m[2] : t;
  let peg = '';
  const pm = PEG.exec(rest);
  if (pm) {
    peg = pm[0];
    rest = rest.slice(0, -peg.length);
  }
  return (m ? m[1] : '') + encodeUrlPath(rest).replace(/@/g, '%40') + peg;
}

/** `base/seg1/seg2`: every segment is a plain (decoded) name, e.g. from `svn list`, and gets encoded. */
export function joinSvnUrl(base: string, ...names: string[]): string {
  const segs = names.flatMap((n) => n.split('/')).filter((s) => s !== '');
  return [base.replace(/\/+$/, ''), ...segs.map((s) => encodeURIComponent(s))].join('/');
}

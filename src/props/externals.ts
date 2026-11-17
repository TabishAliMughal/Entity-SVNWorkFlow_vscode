export interface ExternalDef {
  /** URL as written: absolute, `^/...`, `//host/...`, `/...` or `../...`, without the `@peg` suffix. */
  url: string;
  /** Peg revision (`URL@PEG`). */
  peg?: string;
  /** Operative revision (`-r REV`). */
  rev?: string;
  /** Local directory the external is checked out into. */
  dir: string;
}

const URLISH = /^([a-z][a-z0-9+.-]*:\/\/|\^\/|\/\/|\/|\.\.\/)/i;

export const isUrlish = (t: string): boolean => URLISH.test(t);

/** Shell-like tokens: whitespace separated, `"..."`/`'...'` quoting and backslash escapes (svn:externals syntax). */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === '\\' && i + 1 < line.length && (line[i + 1] === quote || line[i + 1] === '\\')) cur += line[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === '\\' && i + 1 < line.length && /[\s"'\\]/.test(line[i + 1])) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (cur || has) out.push(cur);
  return out;
}

function splitPeg(url: string): { url: string; peg?: string } {
  // A peg is the text after the last '@' when that '@' follows the last '/' (user@host in the authority is not a peg).
  const at = url.lastIndexOf('@');
  if (at <= url.lastIndexOf('/')) return { url };
  const peg = url.slice(at + 1);
  return /^(\d+|HEAD|BASE|COMMITTED|PREV|\{.+\})?$/i.test(peg) ? { url: url.slice(0, at), peg: peg || undefined } : { url };
}

/** Parses one definition line (svn 1.5+ `[-r REV] URL[@PEG] DIR` and the old `DIR [-r REV] URL`); undefined when not recognisable. */
export function parseExternalLine(line: string): ExternalDef | undefined {
  const t = tokenize(line.trim());
  if (t.length < 2) return undefined;
  let rev: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '-r' && i + 1 < t.length) rev = t[++i];
    else if (/^-r\S+$/.test(t[i])) rev = t[i].slice(2);
    else rest.push(t[i]);
  }
  if (rest.length !== 2) return undefined;
  const [a, b] = rest;
  let urlTok: string;
  let dir: string;
  if (isUrlish(a)) {
    urlTok = a;
    dir = b;
  } else if (isUrlish(b)) {
    urlTok = b;
    dir = a;
  } else return undefined;
  const { url, peg } = splitPeg(urlTok);
  return { url, peg, rev, dir };
}

export interface ParsedExternals {
  defs: ExternalDef[];
  /** Comment and unparseable lines, kept so a round trip does not lose them. */
  other: string[];
}

export function parseExternals(text: string): ParsedExternals {
  const defs: ExternalDef[] = [];
  const other: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const d = line.startsWith('#') ? undefined : parseExternalLine(line);
    if (d) defs.push(d);
    else other.push(line);
  }
  return { defs, other };
}

const quote = (s: string): string => (/[\s"'\\]/.test(s) ? `"${s.replace(/(["\\])/g, '\\$1')}"` : s);

export function formatExternal(d: ExternalDef): string {
  const url = d.peg ? `${d.url}@${d.peg}` : d.url;
  return `${d.rev ? `-r${d.rev} ` : ''}${quote(url)} ${quote(d.dir)}`;
}

export function formatExternals(defs: readonly ExternalDef[], other: readonly string[] = []): string {
  const lines = [...other, ...defs.map(formatExternal)];
  return lines.length ? lines.join('\n') + '\n' : '';
}

/** Problems a row would cause; empty when fine. */
export function validateExternal(d: ExternalDef): string[] {
  const errs: string[] = [];
  if (!d.url.trim()) errs.push('URL is required');
  else if (!isUrlish(d.url.trim())) errs.push('URL must be absolute (svn://, http(s)://), ^/relative, //host/..., /... or ../...');
  if (/\s/.test(d.url)) errs.push('URL must not contain spaces (use %20)');
  if (!d.dir.trim()) errs.push('Local directory is required');
  else if (/^([a-z]:|[\\/])/i.test(d.dir) || d.dir.split(/[\\/]/).includes('..')) errs.push('Local directory must be relative and stay inside the folder');
  if (d.peg && !/^(\d+|HEAD|\{.+\})$/i.test(d.peg)) errs.push('Peg revision must be a number, HEAD or {date}');
  if (d.rev && !/^(\d+|HEAD|\{.+\})$/i.test(d.rev)) errs.push('Revision must be a number, HEAD or {date}');
  return errs;
}

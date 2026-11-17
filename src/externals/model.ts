import { XMLParser } from 'fast-xml-parser';

/** One `svn:externals` definition found on a directory (or URL). */
export interface ExternalRef {
  /** Directory (absolute local path, or URL for a remote query) that carries the property. */
  parent: string;
  /** Target folder name inside `parent`. */
  localDir: string;
  /** URL exactly as written in the definition. */
  url: string;
  /** scheme://host:port the definition resolves to (undefined when it cannot be determined). */
  origin?: string;
}

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443', 'svn:': '3690', 'svn+ssh:': '22' };

const ABS_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

/** `scheme://host:port` in lower case with the default port made explicit; credentials in the URL are ignored. */
export function originOf(url: string): string | undefined {
  if (!ABS_URL.test(url.trim())) return undefined;
  try {
    const u = new URL(url.trim());
    if (!u.hostname) return undefined;
    return `${u.protocol}//${u.hostname.toLowerCase()}:${u.port || DEFAULT_PORTS[u.protocol] || ''}`;
  } catch {
    return undefined;
  }
}

/**
 * Where an external URL points. `^/`, `../`, `/` stay on the repository's origin; `//host/...` takes the
 * scheme of the repository but may name another host.
 */
export function resolveExternalOrigin(rawUrl: string, repoOrigin: string): string | undefined {
  const u = rawUrl.trim();
  if (u.startsWith('//')) {
    const scheme = /^([a-z][a-z0-9+.-]*:)/i.exec(repoOrigin)?.[1];
    return scheme ? originOf(`${scheme}${u}`) : undefined;
  }
  if (u.startsWith('^/') || u.startsWith('../') || u.startsWith('/')) return repoOrigin;
  return originOf(u);
}

function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | undefined;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length && (quote ? line[i + 1] === quote || line[i + 1] === '\\' : /[\s"'\\]/.test(line[i + 1]))) {
      cur += line[++i];
      has = true;
    } else if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

const urlLike = (t: string): boolean => ABS_URL.test(t) || t.startsWith('^/') || t.startsWith('//') || t.startsWith('../') || t.startsWith('/');

/** Parses the lines of one svn:externals value (new `[-r N] URL DIR` and old `DIR [-r N] URL` formats). */
export function parseExternalsValue(value: string): Array<{ url: string; localDir: string }> {
  const out: Array<{ url: string; localDir: string }> = [];
  for (const raw of value.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const toks = tokenize(line);
    const rest: string[] = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t === '-r' || t === '--revision') i++;
      else if (/^-r\S+/.test(t)) continue;
      else rest.push(t);
    }
    if (rest.length !== 2) continue;
    if (urlLike(rest[0])) out.push({ url: rest[0], localDir: rest[1] });
    else if (urlLike(rest[1])) out.push({ url: rest[1], localDir: rest[0] });
  }
  return out;
}

/** Parses `svn propget -R svn:externals --xml` output into one entry per defining directory. */
export function parseExternalsXml(xml: string): Array<{ target: string; value: string }> {
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, isArray: (n) => n === 'target' || n === 'property' }).parse(xml);
  const out: Array<{ target: string; value: string }> = [];
  for (const t of doc?.properties?.target ?? []) {
    for (const p of t.property ?? []) {
      const value = typeof p === 'string' ? p : (p['#text'] ?? '');
      if (value) out.push({ target: String(t['@_path']), value: String(value) });
    }
  }
  return out;
}

/** Flattens propget XML into definitions; `resolveParent` maps the reported path (possibly relative) to its absolute form. */
export function externalsFromXml(xml: string, repoOrigin: string, resolveParent: (p: string) => string = (p) => p): ExternalRef[] {
  const refs: ExternalRef[] = [];
  for (const e of parseExternalsXml(xml)) {
    for (const d of parseExternalsValue(e.value)) {
      refs.push({ parent: resolveParent(e.target), localDir: d.localDir, url: d.url, origin: resolveExternalOrigin(d.url, repoOrigin) });
    }
  }
  return refs;
}

/** Externals whose server differs from the repository's and is not trusted yet; file:// never receives credentials. */
export function foreignExternals(refs: readonly ExternalRef[], repoOrigin: string, trusted: readonly string[] = []): ExternalRef[] {
  const t = new Set(trusted.map((x) => originOf(x) ?? x.toLowerCase()));
  return refs.filter((r) => {
    if (/^file:\/\//i.test(r.url)) return false;
    if (!r.origin) return true;
    return r.origin !== repoOrigin && !t.has(r.origin);
  });
}

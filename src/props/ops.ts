import { RepoEntry } from '../repos/model';
import { SvnClient, pegSafe } from '../svn/client';
import { SvnError } from '../svn/errors';
import { parseXml } from '../svn/xml';
import { withTempFile } from '../util/tempFile';
import { PropChange, validateChange } from './model';

interface Ctx {
  client: SvnClient;
  repo: RepoEntry;
  signal?: AbortSignal;
}
const opts = (c: Ctx) => ({ repoName: c.repo.name, cwd: c.repo.localFolder, signal: c.signal });

export interface Prop {
  name: string;
  value: string;
}

export async function listPropNames(c: Ctx, p: string): Promise<string[]> {
  const r = await c.client.run(['proplist', '-q', '--', pegSafe(p)], { ...opts(c), xml: true });
  const doc = parseXml(r.text)?.properties;
  const prop = doc?.target?.[0]?.property ?? doc?.target?.property ?? doc?.property;
  const list = prop === undefined ? [] : Array.isArray(prop) ? prop : [prop];
  return list.map((x: { '@_name'?: string }) => String(x['@_name'])).filter((n: string) => n && n !== 'undefined').sort();
}

/** `propget --strict` keeps the exact value (no trailing newline added by svn). */
export async function getProp(c: Ctx, p: string, name: string): Promise<string | undefined> {
  try {
    const r = await c.client.run(['propget', '--strict', '--', name, pegSafe(p)], opts(c));
    // svn prints svn:* values with native line ends (CRLF on Windows); other properties are returned verbatim.
    return name.startsWith('svn:') ? r.text.replace(/\r\n/g, '\n') : r.text;
  } catch (e) {
    if (e instanceof SvnError && /W200017/.test(`${e.message} ${e.stderr}`)) return undefined;
    throw e;
  }
}

export async function listProps(c: Ctx, p: string): Promise<Prop[]> {
  const out: Prop[] = [];
  for (const name of await listPropNames(c, p)) out.push({ name, value: (await getProp(c, p, name)) ?? '' });
  return out;
}

/**
 * `svn propset -F <tmp>`: the value (any text, multi-line, `*`, quotes) never touches the command line, so no
 * argument splitting or wildcard expansion can alter it (svn.exe expands a bare `*` argument on Windows). The
 * temp file lives in `tmpDir` (globalStorage) and is deleted afterwards.
 */
export async function setProp(c: Ctx, p: string, name: string, value: string, o: { tmpDir: string; recursive?: boolean }): Promise<void> {
  await withTempFile(o.tmpDir, value, (file) => c.client.run(['propset', ...(o.recursive ? ['-R'] : []), '-F', file, '--', name, pegSafe(p)], opts(c)));
}

export async function deleteProp(c: Ctx, p: string, name: string, recursive = false): Promise<void> {
  await c.client.run(['propdel', ...(recursive ? ['-R'] : []), '--', name, pegSafe(p)], opts(c));
}

/** Applies a list of edits after validating all of them; stops at the first svn failure. Returns the names that changed. */
export async function applyChanges(c: Ctx, p: string, isDir: boolean, changes: readonly PropChange[], tmpDir: string): Promise<string[]> {
  for (const ch of changes) {
    const bad = validateChange(ch, isDir);
    if (bad) throw new Error(bad);
  }
  const done: string[] = [];
  for (const ch of changes) {
    const recursive = !!ch.recursive && isDir && ch.name !== 'svn:externals';
    if (ch.value === undefined) await deleteProp(c, p, ch.name, recursive);
    else await setProp(c, p, ch.name, ch.value, { tmpDir, recursive });
    done.push(ch.name);
  }
  return done;
}

export interface ExternalsLocation {
  /** Folder (absolute) that carries the property. */
  dir: string;
  value: string;
}

/** Every folder under `root` with svn:externals (`propget -R`). */
export async function listExternalsUnder(c: Ctx, root: string): Promise<ExternalsLocation[]> {
  const r = await c.client.run(['propget', '-R', '--xml', '--', 'svn:externals', pegSafe(root)], opts(c));
  const targets = parseXml(r.text)?.properties?.target;
  const list = targets === undefined ? [] : Array.isArray(targets) ? targets : [targets];
  return list
    .map((t: { '@_path'?: string; property?: unknown }) => {
      const prop = (Array.isArray(t.property) ? t.property[0] : t.property) as { '#text'?: string } | string | undefined;
      return { dir: String(t['@_path']), value: typeof prop === 'string' ? prop : String(prop?.['#text'] ?? '') };
    })
    .filter((x: ExternalsLocation) => x.dir !== 'undefined');
}

import * as path from 'node:path';
import { RepoEntry } from '../repos/model';
import { SvnClient, pegSafe } from '../svn/client';
import { parseStatus } from '../svn/xml';
import { changelistNames } from './model';

interface Ctx {
  client: SvnClient;
  repo: RepoEntry;
  signal?: AbortSignal;
}
const opts = (c: Ctx) => ({ repoName: c.repo.name, cwd: c.repo.localFolder, signal: c.signal });

/** `svn changelist NAME paths...` (creates the changelist when it does not exist yet). Only versioned files can join. */
export async function addToChangelist(c: Ctx, name: string, paths: readonly string[]): Promise<void> {
  await c.client.run(['changelist', '--', name, ...paths.map(pegSafe)], opts(c));
}

export async function removeFromChangelist(c: Ctx, paths: readonly string[]): Promise<void> {
  await c.client.run(['changelist', '--remove', '--', ...paths.map(pegSafe)], opts(c));
}

/** Every changelist of the working copy with its member paths (relative, as svn prints them). */
export async function listChangelists(c: Ctx): Promise<Map<string, string[]>> {
  const r = await c.client.run(['status', '--depth', 'infinity', '-q'], { ...opts(c), xml: true });
  const out = new Map<string, string[]>();
  for (const e of parseStatus(r.text).entries) if (e.changelist) out.set(e.changelist, [...(out.get(e.changelist) ?? []), e.path]);
  return out;
}

export async function changelistNamesOf(c: Ctx): Promise<string[]> {
  return changelistNames([...(await listChangelists(c)).keys()].map((changelist) => ({ changelist })));
}

/** Clearing = removing every member (svn has no "delete changelist"). */
export async function clearChangelist(c: Ctx, name: string): Promise<number> {
  const members = (await listChangelists(c)).get(name) ?? [];
  if (members.length) await removeFromChangelist(c, members.map((p) => path.resolve(c.repo.localFolder, p)));
  return members.length;
}

/** Rename = move members to the new name. Existing members of the target name merge in. */
export async function renameChangelist(c: Ctx, from: string, to: string): Promise<number> {
  const members = (await listChangelists(c)).get(from) ?? [];
  if (members.length) await addToChangelist(c, to, members.map((p) => path.resolve(c.repo.localFolder, p)));
  return members.length;
}

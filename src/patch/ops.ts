import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RepoEntry } from '../repos/model';
import type { SvnClient } from '../svn/client';
import { PatchApplyOptions, PatchOutcome, REJECT_SUFFIX, buildPatchArgs, parsePatchOutput, unsafePatchTargets } from './model';

export interface PatchCtx {
  client: SvnClient;
  repo: RepoEntry;
  /** Folder `svn patch` runs in; patch paths are relative to it. */
  cwd: string;
  signal?: AbortSignal;
}

export interface PatchRun {
  outcome: PatchOutcome;
  /** Absolute `.svnpatch.rej` files that exist after a real run. */
  rejects: string[];
  raw: string;
}

export async function runPatch(c: PatchCtx, o: PatchApplyOptions): Promise<PatchRun> {
  const bad = unsafePatchTargets(await fs.readFile(o.patchFile, 'utf8'));
  if (bad.length) throw new Error(`The patch names files outside the working copy (absolute or ".." paths), so it was not applied: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ', ...' : ''}`);
  const r = await c.client.run(buildPatchArgs(o), { repoName: c.repo.name, cwd: c.cwd, signal: c.signal });
  const outcome = parsePatchOutput(r.text);
  const rejects: string[] = [];
  if (!o.dryRun) {
    for (const p of outcome.conflicts) {
      const rej = path.resolve(c.cwd, p + REJECT_SUFFIX);
      if (await fs.stat(rej).then(() => true, () => false)) rejects.push(rej);
    }
  }
  return { outcome, rejects, raw: r.text };
}

export function summarizeOutcome(o: PatchOutcome): string {
  const n = (a: string): number => o.entries.filter((e) => e.action.startsWith(a) || e.action.endsWith(a)).length;
  const bits = [`${o.entries.length} file(s)`];
  const add = n('A');
  const del = n('D');
  if (add) bits.push(`${add} added`);
  if (del) bits.push(`${del} deleted`);
  if (o.conflicts.length) bits.push(`${o.conflicts.length} with rejected hunks`);
  if (o.skipped.length) bits.push(`${o.skipped.length} skipped (target missing)`);
  return bits.join(', ');
}

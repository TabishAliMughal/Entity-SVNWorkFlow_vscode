import type { RepoEntry } from '../repos/model';
import type { SvnClient } from '../svn/client';
import { ExportOptions, buildExportArgs, countExported, parseExportedRevision } from './model';

export interface ExportCtx {
  client: SvnClient;
  repo: RepoEntry;
  signal?: AbortSignal;
}

export async function runExport(c: ExportCtx, opts: ExportOptions): Promise<{ revision?: number; items: number }> {
  const r = await c.client.run(buildExportArgs(opts), { repoName: c.repo.name, cwd: c.repo.localFolder, signal: c.signal, timeoutMs: 6 * 60 * 60_000 });
  return { revision: parseExportedRevision(r.text), items: countExported(r.text) };
}

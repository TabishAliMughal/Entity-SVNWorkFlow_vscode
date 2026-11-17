import * as vscode from 'vscode';
import { RepoEntry } from '../repos/model';
import { resolveTarget } from '../commands/target';
import { Services } from '../services';
import { ChangeItem, NoIncomingError } from './model';

export interface IncomingTarget {
  repo: RepoEntry;
  fsPath: string;
  /** Incoming items at or under the target (the target itself for a file). */
  items: ChangeItem[];
}

/**
 * Guard for Override and Update / Override and Commit (D10). Refreshes the repo's
 * server state first (so a stale cache never enables a destructive action), then
 * throws NoIncomingError (shown as a warning by reportError) if nothing under
 * the target has incoming changes. A failed server check also throws: the
 * incoming state cannot be verified. Pass `{ refresh: false }` to trust the cache.
 */
export async function requireIncoming(services: Services, uri?: vscode.Uri | string, opts: { refresh?: boolean } = {}): Promise<IncomingTarget> {
  const target = typeof uri === 'string' ? { repo: services.resolver.require(uri), fsPath: uri } : resolveTarget(services, uri);
  if (opts.refresh !== false) {
    await services.incoming.refresh({ repoName: target.repo.name, remote: true, manual: true });
    const err = services.incoming.getState(target.repo.name)?.error;
    if (err) throw new Error(`Cannot verify incoming changes for "${target.repo.name}": ${err.message}`);
  }
  const items = services.incoming.incomingUnder(target.fsPath);
  if (!items.length) throw new NoIncomingError(target.fsPath);
  return { repo: target.repo, fsPath: target.fsPath, items };
}

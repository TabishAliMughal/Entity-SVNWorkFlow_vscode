import * as path from 'node:path';
import type { SvnClient } from '../svn/client';
import type { Logger } from '../util/logger';
import { findWcRootUp } from './discover';
import { CurrentRepo } from './store';

/**
 * Finds the working copy containing `focus` (the opened folder) with `svn info`; nothing is saved.
 * Returns undefined when the folder is not inside a working copy or svn cannot read it.
 */
export async function discoverRepo(client: Pick<SvnClient, 'info'>, focus: string | undefined, logger: Logger, findRoot: (p: string) => string | undefined = findWcRootUp): Promise<CurrentRepo | undefined> {
  if (!focus) return undefined;
  const root = findRoot(focus);
  if (!root) return undefined;
  try {
    const info = await client.info(root, { cwd: root });
    return { name: path.basename(focus) || focus, serverUrl: info.url, localFolder: root, repositoryRoot: info.repositoryRoot, uuid: info.repositoryUuid };
  } catch (e) {
    logger.warn(`svn info failed for ${root}: ${e instanceof Error ? e.message.split(/\r?\n/)[0] : String(e)}`);
    return undefined;
  }
}

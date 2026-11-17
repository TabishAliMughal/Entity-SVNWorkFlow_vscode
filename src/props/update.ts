import { updatePaths } from '../ops/svnOps';
import { groupPathsByRepo } from '../ops/targets';
import { SvnTarget } from '../pane/commands';
import { Services } from '../services';
import { notifySuccess, runOperation } from '../util/notify';

/** `svn update` of the folders; that also checks out or updates their svn:externals. */
export async function updateExternals(services: Services, targets: SvnTarget[]): Promise<void> {
  for (const g of groupPathsByRepo(targets).values()) {
    await runOperation('Updating externals', (signal) => updatePaths({ client: services.client, repo: g.repo, signal }, g.paths));
  }
  notifySuccess(services, 'Updated (externals included).');
}

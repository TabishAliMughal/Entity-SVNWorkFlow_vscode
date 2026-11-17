import * as path from 'node:path';
import * as vscode from 'vscode';
import { deleteBackup } from './override/backup';
import { cleanTmp, staleBackups } from './override/housekeeping';
import { registerRepoCommands } from './commands/repoCommands';
import { registerWorkflowCommands } from './commands/workflowCommands';
import { registerWcCommands } from './commands/wcCommands';
import { registerStatus } from './status/register';
import { registerOverrideCommit } from './override/commitCommand';
import { registerIncoming } from './incoming/binding';
import { registerPane } from './pane/register';
import type { ChangesProvider } from './pane/provider';
import type { BlameController } from './blame/ui';
import { registerCompare } from './compare/commands';
import { registerBlame } from './blame/ui';
import { registerHistory } from './history/register';
import { registerLocks } from './locks/register';
import { registerProps } from './props/register';
import { registerConflicts } from './conflict/register';
import { registerMerge } from './merge/register';
import { registerBranches } from './branch/register';
import { registerExport } from './export/register';
import { registerDiffModes } from './diffmodes/register';
import { registerPatch } from './patch/register';
import { registerShelve } from './shelve/register';
import { registerCommandLog } from './cmdlog/register';
import { registerAuth } from './auth/register';
import { CONFIG_SECTION, Services, UNTRUSTED_MESSAGE, createServices , setFocusOverride } from './services';
import { reportError } from './util/ui';

/** Handles for the end-to-end suite in a real VS Code host; only returned when SVN_WORKFLOW_E2E=1 (never in normal use). */
export interface E2EApi {
  services: Services;
  pane: ChangesProvider;
  blame: BlameController;
  /** Pins the focus folder (the test host has no folder open) and finds its working copy. */
  setFocus(folder: string | undefined): Promise<void>;
}

export function activate(context: vscode.ExtensionContext): E2EApi | undefined {
  const services = createServices(context);
  registerCommandLog(context, services);
  registerRepoCommands(context, services);
  const pane = registerPane(context, services);
  registerIncoming(context, services);
  registerWorkflowCommands(context, services);
  registerWcCommands(context, services);
  registerOverrideCommit(context, services);
  registerStatus(context, services);
  const blame = registerBlame(context, services);
  registerHistory(context, services, blame);
  const compareCtx = registerCompare(context, services);
  registerConflicts(context, services, compareCtx);
  registerBranches(context, services, registerMerge(context, services, compareCtx));
  registerExport(context, services);
  registerDiffModes(context, services, compareCtx);
  registerPatch(context, services, compareCtx);
  registerShelve(context, services, compareCtx);
  registerLocks(context, services);
  registerProps(context, services);
  registerAuth(context, services);

  setupTrust(context, services);
  void housekeeping(context, services).catch((e: unknown) => services.logger.warn(`Housekeeping failed: ${e instanceof Error ? e.message : String(e)}`));

  // Surface a missing svn.exe once at startup instead of on first failure.
  const found = services.locator.discover();
  if (found.path) {
    const from = found.source === 'setting' ? 'svnWorkflow.svnPath setting' : found.source === 'tortoiseSvn' ? 'TortoiseSVN folder' : 'PATH';
    services.logger.info(`Using svn.exe at ${found.path} (found via ${from})`);
  } else {
    services.logger.warn('svn.exe not found');
    try {
      services.locator.getExe();
    } catch (e) {
      void reportError(services, e);
    }
  }
  return process.env.SVN_WORKFLOW_E2E === '1' ? { services, pane, blame, setFocus: async (folder) => { setFocusOverride(folder); await services.rediscover(); } } : undefined;
}

/** SVN is off in untrusted workspaces; say so once, and start working as soon as trust is granted. */
function setupTrust(context: vscode.ExtensionContext, services: Services): void {
  if (!vscode.workspace.isTrusted) {
    services.logger.warn(UNTRUSTED_MESSAGE);
    void vscode.window.showWarningMessage(`SVN Workflow: ${UNTRUSTED_MESSAGE}`, 'Manage Workspace Trust').then((pick) => {
      if (pick) void vscode.commands.executeCommand('workbench.trust.manage');
    });
  }
  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      services.logger.info('Workspace trusted: SVN operations enabled.');
      void services.rediscover().then(() => services.incoming.requestRefresh({ remote: true }));
    }),
  );
}

/** Scratch files from crashed runs are removed; old unfinished override backups are offered for deletion. */
async function housekeeping(context: vscode.ExtensionContext, services: Services): Promise<void> {
  const removed = await cleanTmp(services.tmpDir);
  if (removed) services.logger.info(`Removed ${removed} leftover temporary file(s) from ${services.tmpDir}`);
  const days = vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>('override.backupMaxAgeDays', 30);
  const stale = await staleBackups(path.join(context.globalStorageUri.fsPath, 'override-backups'), days);
  if (!stale.length) return;
  const pick = await vscode.window.showWarningMessage(
    `SVN: ${stale.length} Override and Commit backup(s) of runs that did not finish are older than ${days} days. They hold plain copies of your local source files.`,
    'Delete Them',
    'Keep',
  );
  if (pick !== 'Delete Them') return;
  for (const b of stale) await deleteBackup(b.dir);
  services.logger.info(`Deleted ${stale.length} old override backup(s)`);
}

export function deactivate(): void {}

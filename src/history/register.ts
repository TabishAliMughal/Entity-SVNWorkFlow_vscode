import * as vscode from 'vscode';
import type { BlameController } from '../blame/ui';
import { registerSvnCommand } from '../pane/commands';
import type { Services } from '../services';
import { reportError } from '../util/ui';
import { HistoryContext, openHistory } from './panel';

export function registerHistory(context: vscode.ExtensionContext, services: Services, blame?: BlameController): void {
  const ctx: HistoryContext = {
    services,
    extensionUri: context.extensionUri,
    onWorkingCopyChanged: (p) => blame?.invalidate(p),
  };

  // File, folder, repo node, Explorer, editor and palette (active editor) all arrive as targets.
  registerSvnCommand(context, services, 'svnWorkflow.history', async (targets) => {
    const t = targets[0];
    if (t) await openHistory(ctx, t.repo, t.fsPath);
  });

  // Palette and pane title: history of a whole repository.
  context.subscriptions.push(
    vscode.commands.registerCommand('svnWorkflow.historyRepo', async () => {
      try {
        const repos = services.repos.list();
        if (!repos.length) {
          void vscode.window.showWarningMessage('SVN: no repositories are configured.');
          return;
        }
        const repo =
          repos.length === 1
            ? repos[0]
            : (await vscode.window.showQuickPick(repos.map((r) => ({ label: r.name, description: r.serverUrl, repo: r })), { placeHolder: 'Repository to show history for' }))?.repo;
        if (repo) await openHistory(ctx, repo, repo.localFolder);
      } catch (e) {
        await reportError(services, e);
      }
    }),
  );
}

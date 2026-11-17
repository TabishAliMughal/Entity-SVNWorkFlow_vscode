import * as vscode from 'vscode';
import { aggregateIncoming } from '../incoming/model';
import { Services } from '../services';
import { capPathKeys } from '../util/pathKeys';
import { activity } from './activity';
import { countItems, statusBarText, statusBarTooltip } from './format';

const setContext = (key: string, value: unknown): void => void vscode.commands.executeCommand('setContext', key, value);

/** Status bar item and the `unversionedPaths` / `outgoingPaths` context keys used by menu "when" clauses. */
export function registerStatus(context: vscode.ExtensionContext, services: Services): void {
  const { incoming, repos, resolver } = services;
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  bar.command = 'svnWorkflow.statusBar.menu';
  bar.name = 'SVN Workflow';

  const render = (): void => {
    if (!repos.list().length) {
      bar.hide();
      return;
    }
    const file = vscode.window.activeTextEditor?.document.uri;
    const repo = file?.scheme === 'file' ? resolver.resolve(file.fsPath) : undefined;
    const states = repo ? incoming.allStates().filter((s) => s.repoName === repo.name) : incoming.allStates();
    const counts = countItems(states.flatMap((s) => s.items));
    const input = {
      busy: activity.busy || incoming.isBusy(),
      repoName: repo?.name,
      ...counts,
      failing: states.filter((s) => s.error).length,
    };
    bar.text = statusBarText(input);
    bar.tooltip = statusBarTooltip(input, activity.current);
    bar.backgroundColor = counts.incoming ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    bar.show();
  };

  const publishKeys = (): void => {
    const items = incoming.allItems();
    const unversioned = items.filter((i) => i.item === 'unversioned').map((i) => vscode.Uri.file(i.path).fsPath);
    const outgoing: string[] = [];
    for (const repo of incoming.visibleRepos()) {
      const paths = (incoming.getState(repo.name)?.items ?? []).filter((i) => i.outgoing && i.item !== 'unversioned').map((i) => i.path);
      if (paths.length) outgoing.push(...aggregateIncoming(paths, repo.localFolder).map((p) => vscode.Uri.file(p).fsPath));
    }
    setContext('svnWorkflow.unversionedPaths', capPathKeys('svnWorkflow.unversionedPaths', unversioned, services.logger));
    setContext('svnWorkflow.outgoingPaths', capPathKeys('svnWorkflow.outgoingPaths', outgoing, services.logger));
  };

  context.subscriptions.push(
    bar,
    incoming.onDidChange(() => {
      render();
      publishKeys();
    }),
    incoming.onDidChangeBusy(render),
    activity.onDidChange(render),
    repos.onDidChange(render),
    vscode.window.onDidChangeActiveTextEditor(render),
    vscode.commands.registerCommand('svnWorkflow.statusBar.menu', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(list-tree) Open SVN Changes view', id: 'open' },
          { label: '$(refresh) Refresh (check server)', id: 'refresh' },
          { label: '$(output) Show Output', id: 'output' },
        ],
        { placeHolder: 'SVN Workflow' },
      );
      if (pick?.id === 'open') await vscode.commands.executeCommand('svnWorkflow.pane.focus');
      else if (pick?.id === 'refresh') await vscode.commands.executeCommand('svnWorkflow.refresh');
      else if (pick?.id === 'output') services.output.show(true);
    }),
  );
  render();
  publishKeys();
}

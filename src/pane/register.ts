import * as path from 'node:path';
import * as vscode from 'vscode';
import { Services } from '../services';
import { openItemCompare } from '../compare/commands';
import { registerSvnCommand } from './commands';
import { FILTER_TITLES, PaneFilter, parseFilter } from './model';
import { ItemNode, isItemNode } from './nodes';
import { ChangesProvider } from './provider';
import { ViewMode, parseViewMode } from './tree';

const FILTER_KEY = 'svnWorkflow.paneFilter';
const MODE_KEY = 'svnWorkflow.paneViewMode';
export const VIEW_ID = 'svnWorkflow.pane';

export function registerPane(context: vscode.ExtensionContext, services: Services): ChangesProvider {
  const provider = new ChangesProvider(services, parseFilter(context.workspaceState.get(FILTER_KEY)), parseViewMode(context.workspaceState.get(MODE_KEY)), context.extensionUri);
  const view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, canSelectMany: true, showCollapseAll: true });

  const sync = (): void => {
    const f = provider.getFilter();
    void vscode.commands.executeCommand('setContext', FILTER_KEY, f);
    void vscode.commands.executeCommand('setContext', MODE_KEY, provider.getViewMode());
    const repo = services.incoming.visibleRepos()[0];
    const folder = repo ? services.incoming.scopeOf(repo)[0] : undefined;
    view.description = folder ? `${FILTER_TITLES[f]} - ${path.basename(folder) || folder}` : FILTER_TITLES[f];
    const n = provider.incomingCount();
    view.badge = n ? { value: n, tooltip: `${n} incoming change${n === 1 ? '' : 's'}` } : undefined;
  };
  const setFilter = (f: PaneFilter): void => {
    provider.setFilter(f);
    void context.workspaceState.update(FILTER_KEY, f);
    sync();
  };

  const setMode = (m: ViewMode): void => {
    provider.setViewMode(m);
    void context.workspaceState.update(MODE_KEY, m);
    sync();
  };

  context.subscriptions.push(
    view,
    vscode.commands.registerCommand('svnWorkflow.pane.viewAsTree', () => setMode('tree')),
    vscode.commands.registerCommand('svnWorkflow.pane.viewAsList', () => setMode('list')),
    { dispose: () => provider.dispose() },
    services.incoming.onDidChange(() => {
      provider.refresh();
      sync();
    }),
    services.repos.onDidChange(() => provider.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
    vscode.commands.registerCommand('svnWorkflow.pane.filterOutgoing', () => setFilter('outgoing')),
    vscode.commands.registerCommand('svnWorkflow.pane.filterIncoming', () => setFilter('incoming')),
    vscode.commands.registerCommand('svnWorkflow.pane.filterAll', () => setFilter('all')),
    vscode.commands.registerCommand('svnWorkflow.pane.openDiff', async (node?: unknown) => {
      if (isItemNode(node)) await openItemCompare({ services, extensionUri: context.extensionUri }, node as ItemNode);
    }),
  );

  registerSvnCommand(context, services, 'svnWorkflow.pane.openFile', async (targets) => {
    for (const t of targets) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(t.fsPath));
  });

  sync();
  return provider;
}

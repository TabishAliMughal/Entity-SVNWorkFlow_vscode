import * as vscode from 'vscode';
import { CONFIG_SECTION, Services, currentFocus } from '../services';
import { repoLocks } from '../override/commitLocks';
import { SvnError } from '../svn/errors';
import { capPathKeys } from '../util/pathKeys';
import { reportError } from '../util/ui';
import { WcDbWatcher } from './wcdb';

/** Writes to wc.db right after our own operation or status run are ours, not external. */
const OWN_GRACE_MS = 3000;

function setContext(key: string, value: unknown): void {
  void vscode.commands.executeCommand('setContext', key, value);
}

/** Connects IncomingService to VS Code: context keys, settings, triggers, error notifications. */
export function registerIncoming(context: vscode.ExtensionContext, services: Services): void {
  const { incoming, repos, resolver, logger } = services;

  const publish = (): void => {
    setContext('svnWorkflow.hasRepos', repos.list().length > 0);
    setContext('svnWorkflow.hasScopedRepo', incoming.visibleRepos().length > 0);
    // Uri.file().fsPath matches what `resourcePath` yields for explorer/editor menus.
    const paths = capPathKeys('svnWorkflow.incomingPaths', incoming.aggregatedIncomingPaths().map((p) => vscode.Uri.file(p).fsPath), logger);
    setContext('svnWorkflow.incomingPaths', paths);
    setContext('svnWorkflow.hasIncoming', paths.length > 0);
  };

  const applyInterval = (): void => {
    const sec = vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>('incomingCheckIntervalSeconds', 300);
    incoming.setCheckInterval(sec > 0 ? Math.max(30, sec) * 1000 : 0);
  };

  const quietUntil = new Map<string, number>();
  const markOwn = (name?: string): void => {
    const until = Date.now() + OWN_GRACE_MS;
    if (name) quietUntil.set(name, until);
    else for (const r of repos.list()) quietUntil.set(r.name, until);
  };

  let watchers: vscode.Disposable[] = [];
  const rewatch = (): void => {
    watchers.forEach((w) => w.dispose());
    watchers = incoming.visibleRepos().map((repo) => {
      const db = new WcDbWatcher({
        folder: repo.localFolder,
        isOwnActivity: () => repoLocks.isBusy(repo.name) || incoming.isBusy() || Date.now() < (quietUntil.get(repo.name) ?? 0),
        onExternalChange: () => {
          logger.info(`Working copy of "${repo.name}" changed outside the extension; refreshing`);
          incoming.requestRefresh({ repoName: repo.name, remote: true });
        },
      });
      db.start();
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repo.localFolder, '**'));
      const hit = (uri: vscode.Uri): void => {
        if (/[\\/]\.svn([\\/]|$)/.test(uri.fsPath)) return;
        incoming.requestRefresh({ repoName: repo.name, remote: false });
      };
      return vscode.Disposable.from(w, w.onDidChange(hit), w.onDidCreate(hit), w.onDidDelete(hit), db);
    });
  };

  let focus = currentFocus();
  const rescope = (): void => {
    focus = currentFocus();
    rewatch();
    void services.rediscover().catch((e: unknown) => logger.warn(`Working copy discovery failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  // A new checkout (or `svn upgrade`) creates .svn/wc.db: look again for the working copy of the opened folder.
  const dbWatcher = vscode.workspace.createFileSystemWatcher('**/.svn/wc.db', false, true, true);

  context.subscriptions.push(
    incoming.onDidChange(publish),
    incoming.onDidChangeBusy(() => {
      if (!incoming.isBusy()) markOwn();
    }),
    repoLocks.onRelease((name) => markOwn(name)),
    incoming.onDidError((repo, err) => {
      const kind = err instanceof SvnError ? err.kind : 'other';
      // Offline is expected on and off; it shows in the SVN view and Output only. svnNotFound is reported at activation.
      if (kind === 'offline' || kind === 'svnNotFound') return;
      void reportError(services, err, repo.name);
    }),
    repos.onDidChange(() => {
      focus = currentFocus();
      rewatch();
      publish();
      incoming.reposChanged();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CONFIG_SECTION}.incomingCheckIntervalSeconds`)) applyInterval();
    }),
    dbWatcher,
    dbWatcher.onDidCreate(() => {
      if (!repos.list().length) rescope();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => rescope()),
    vscode.window.onDidChangeActiveTextEditor(() => {
      if (currentFocus() !== focus) rescope();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== 'file') return;
      const repo = resolver.resolve(doc.uri.fsPath);
      if (repo) incoming.requestRefresh({ repoName: repo.name, remote: false });
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) incoming.requestRefresh({ remote: false });
    }),
    { dispose: () => watchers.forEach((w) => w.dispose()) },
    vscode.commands.registerCommand('svnWorkflow.refresh', async () => {
      await vscode.window.withProgress({ location: { viewId: 'svnWorkflow.pane' } }, () => incoming.refresh({ remote: true, manual: true }));
      const failed = incoming.allStates().filter((s) => s.error);
      if (failed.length) {
        const text = failed.map((s) => `${s.repoName} (${s.error?.kind})`).join(', ');
        logger.warn(`Remote check failed: ${text}`);
        const pick = await vscode.window.showWarningMessage(`SVN remote check failed for: ${text}. Showing the last known state.`, 'Show Output');
        if (pick) services.output.show(true);
      }
    }),
  );

  publish();
  rewatch();
  applyInterval();
  void services.rediscover().then(() => incoming.refresh({ remote: true }));
}

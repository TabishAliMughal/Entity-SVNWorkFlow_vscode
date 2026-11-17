import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { collectTargets, type SvnTarget } from '../pane/commands';
import { repoLocks } from '../override/commitLocks';
import type { RepoEntry } from '../repos/model';
import type { Services } from '../services';
import { reportError } from './ui';

export async function pickRepo(services: Services, placeHolder: string): Promise<RepoEntry | undefined> {
  const list = services.repos.list();
  if (!list.length) throw new Error('No SVN repository is configured. Add one or use Checkout first.');
  if (list.length === 1) return list[0];
  const active = vscode.window.activeTextEditor?.document.uri;
  const preferred = active?.scheme === 'file' ? services.resolver.resolve(active.fsPath) : undefined;
  const items = list.map((r) => ({ label: r.name, description: r.localFolder, repo: r }));
  items.sort((a, b) => Number(b.repo.name === preferred?.name) - Number(a.repo.name === preferred?.name));
  return (await vscode.window.showQuickPick(items, { placeHolder }))?.repo;
}

/**
 * Like registerSvnCommand (pane item, repo node, Explorer, editor) but called without arguments
 * (palette, view title) it asks for a repository and uses its whole working copy instead of the active file.
 */
export function registerRepoCommand(
  context: vscode.ExtensionContext,
  services: Services,
  id: string,
  handler: (target: SvnTarget) => unknown | Promise<unknown>,
  opts: { refreshAfter?: boolean } = {},
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(id, async (arg?: unknown, selection?: unknown) => {
      let name: string | undefined;
      try {
        let target: SvnTarget | undefined;
        if (arg === undefined || (typeof arg === 'string' && services.repos.find(arg))) {
          const repo = typeof arg === 'string' ? services.repos.find(arg) : await pickRepo(services, 'Which repository (whole working copy)?');
          if (!repo) return;
          target = { repo, fsPath: repo.localFolder };
        } else target = collectTargets(services, arg, selection)[0];
        if (!target) return;
        name = target.repo.name;
        await handler(target);
      } catch (e) {
        await reportError(services, e, name);
      } finally {
        if (opts.refreshAfter && name) services.incoming.requestRefresh({ repoName: name, remote: true });
      }
    }),
  );
}

/** Runs `fn` holding the repo's lock; warns and returns undefined when another SVN operation is running. */
export async function withRepoLock<T>(repoName: string, fn: () => Promise<T>): Promise<T | undefined> {
  const release = repoLocks.tryAcquire(repoName);
  if (!release) {
    void vscode.window.showWarningMessage(`SVN operation in progress on "${repoName}". Wait for it to finish.`);
    return undefined;
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Like withRepoLock but throws when the repo is busy, for steps whose caller must not assume success. */
export { runExclusive as withRepoLockStrict } from '../wc/lock';

/** The folder a command acts on: the target itself when it is a folder, else its parent. */
export function folderOf(fsPath: string): string {
  try {
    return fs.statSync(fsPath).isDirectory() ? fsPath : path.dirname(fsPath);
  } catch {
    return path.dirname(fsPath);
  }
}

export function tmpDirOf(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'tmp');
}

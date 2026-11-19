import * as path from 'node:path';
import * as vscode from 'vscode';
import { assertNoLocalIgnored } from '../localignore/model';
import { requireIncoming } from '../incoming/guard';
import { registerSvnCommand } from '../pane/commands';
import { Services, CONFIG_SECTION } from '../services';
import { SvnError } from '../svn/errors';
import { reportError } from '../util/ui';
import { BackupInfo, deleteBackup, describeEntry, listBackups } from './backup';
import { NothingToOverrideError, assertNoConflicts, OverrideError, collectLocalChanges, overrideAndCommit, restoreFromBackup } from './commitFlow';
import { repoLocks } from './commitLocks';

export const OVERRIDE_COMMIT = 'svnWorkflow.overrideCommit';
export const RESTORE_BACKUP = 'svnWorkflow.restoreOverrideBackup';

const backupRoot = (context: vscode.ExtensionContext): string => path.join(context.globalStorageUri.fsPath, 'override-backups');
const timeoutMs = (): number => Math.max(60, vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>('overrideTimeoutSeconds', 1800)) * 1000;
const keepSetting = (): number => vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>('overrideBackupsToKeep', 5);
const list = (lines: string[], max: number): string => lines.slice(0, max).join('\n') + (lines.length > max ? `\n... and ${lines.length - max} more` : '');

export function registerOverrideCommit(context: vscode.ExtensionContext, services: Services): void {
  registerSvnCommand(context, services, OVERRIDE_COMMIT, (targets) => overrideCommit(context, services, targets), { refreshAfter: true });

  // Not registerSvnCommand: it must work from the palette without any file selected.
  context.subscriptions.push(
    vscode.commands.registerCommand(RESTORE_BACKUP, async (arg?: unknown) => {
      let repoName: string | undefined;
      try {
        // arg: a backup folder (from the failure notification), a Uri/tree node from a menu (limits to its repo), or nothing (palette).
        const uriPath = arg instanceof vscode.Uri && arg.scheme === 'file' ? arg.fsPath : undefined;
        repoName = await restoreBackupCommand(context, services, typeof arg === 'string' ? arg : undefined, uriPath ? services.resolver.resolve(uriPath)?.name : undefined);
      } catch (e) {
        await reportError(services, e);
      } finally {
        if (repoName) services.incoming.requestRefresh({ repoName, remote: true });
      }
    }),
  );
}

async function overrideCommit(context: vscode.ExtensionContext, services: Services, targets: Array<{ fsPath: string }>): Promise<void> {
  if (targets.length !== 1) {
    void vscode.window.showWarningMessage('Override and Commit works on one file or folder at a time. Select a single item.');
    return;
  }
  assertNoLocalIgnored([targets[0].fsPath]);
  const { repo, fsPath, items } = await requireIncoming(services, targets[0].fsPath);
  const rel = path.relative(repo.localFolder, fsPath) || '.';
  const plan = await collectLocalChanges(services.client, repo.name, repo.localFolder, fsPath);
  if (!plan.length) throw new NothingToOverrideError(fsPath);
  await assertNoConflicts(plan, repo.localFolder);

  const detail = [
    `Repository: ${repo.name}`,
    `Target: ${rel}`,
    '',
    `The server has ${items.length} newer change(s) under this target. They will be DISCARDED: your local version replaces whatever teammates committed, and the result is committed to the server.`,
    '',
    `Local changes that will be committed (${plan.length}):`,
    list(plan.map(describeEntry), 15),
    '',
    'A backup of your local files is kept until the commit succeeds.',
  ].join('\n');
  const pick = await vscode.window.showWarningMessage(`Override the server with your local version of "${path.basename(fsPath) || repo.name}"?`, { modal: true, detail }, 'Override and Commit');
  if (pick !== 'Override and Commit') return;

  const message = await vscode.window.showInputBox({
    title: 'Override and Commit',
    prompt: 'Commit message (may be empty)',
    ignoreFocusOut: true,
  });
  if (message === undefined) return;

  const release = repoLocks.tryAcquire(repo.name);
  if (!release) {
    void vscode.window.showWarningMessage(`Another Override operation is already running for "${repo.name}". Wait for it to finish.`);
    return;
  }
  try {
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Override and Commit: ${repo.name}`, cancellable: true }, (progress, token) => {
      const ac = new AbortController();
      token.onCancellationRequested(() => ac.abort());
      return overrideAndCommit({
        svn: services.client,
        repoName: repo.name,
        serverUrl: repo.serverUrl,
        wcRoot: repo.localFolder,
        target: fsPath,
        message: message.trim(),
        backupRoot: backupRoot(context),
        keepBackups: keepSetting(),
        timeoutMs: timeoutMs(),
        signal: ac.signal,
        logger: services.logger,
        progress: (m) => progress.report({ message: m + (m === 'Reverting local changes' ? ' (cannot be cancelled from here)' : '') }),
      });
    });
    const note = result.backupKept ? ` Backup kept: ${result.backupDir}` : '';
    void vscode.window.showInformationMessage(
      result.revision !== undefined ? `Override and Commit finished: committed revision ${result.revision}.${note}` : `Override and Commit finished: your files already match the server, nothing to commit.${note}`,
    );
  } catch (e) {
    if (e instanceof OverrideError) {
      services.logger.error(e.message);
      const pick = await vscode.window.showErrorMessage(e.message, 'Open Backup Folder', 'Restore from Backup', 'Show Output');
      if (pick === 'Open Backup Folder') await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(e.backupDir));
      else if (pick === 'Restore from Backup') await vscode.commands.executeCommand(RESTORE_BACKUP, e.backupDir);
      else if (pick === 'Show Output') services.output.show(true);
      return;
    }
    throw e;
  } finally {
    release();
  }
}

async function restoreBackupCommand(context: vscode.ExtensionContext, services: Services, preselected?: string, onlyRepo?: string): Promise<string | undefined> {
  let all = await listBackups(backupRoot(context));
  if (onlyRepo && !preselected && all.some((b) => b.manifest.repoName.toLowerCase() === onlyRepo.toLowerCase())) all = all.filter((b) => b.manifest.repoName.toLowerCase() === onlyRepo.toLowerCase());
  // No target (palette): with backups of several repositories, ask for the repository first.
  const repoNames = [...new Set(all.map((b) => b.manifest.repoName))];
  if (!preselected && !onlyRepo && repoNames.length > 1) {
    const r = await vscode.window.showQuickPick(repoNames.map((n) => ({ label: n, description: `${all.filter((b) => b.manifest.repoName === n).length} backup(s)` })), { title: 'Restore from Override Backup', placeHolder: 'Which repository?' });
    if (!r) return undefined;
    all = all.filter((b) => b.manifest.repoName === r.label);
  }
  let chosen: BackupInfo | undefined = preselected ? all.find((b) => b.dir === preselected) : undefined;
  if (!chosen) {
    if (!all.length) {
      void vscode.window.showInformationMessage('There are no override backups.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      all.map((b) => ({
        label: `${new Date(b.manifest.createdAt).toLocaleString()}  ${b.manifest.repoName}`,
        description: `${b.manifest.targetRel || '(whole working copy)'}  -  ${b.manifest.entries.length} item(s)`,
        detail: `${b.manifest.completed ? `committed as r${b.manifest.completed.revision ?? '?'}` : 'NOT committed'}${b.manifest.restoredAt ? ', restored before' : ''}  -  ${b.dir}`,
        b,
      })),
      { title: 'Restore from Override Backup', placeHolder: 'Pick a backup to restore into its working copy' },
    );
    chosen = picked?.b;
  }
  if (!chosen) return undefined;
  const { manifest, dir } = chosen;
  const repo = services.repos.find(manifest.repoName);
  if (!repo) throw new Error(`The repository "${manifest.repoName}" of this backup is not configured any more. Re-add it, or copy the files manually from ${dir}\\files.`);

  const ok = await vscode.window.showWarningMessage(
    `Restore ${manifest.entries.length} item(s) from this backup into "${repo.name}"?`,
    { modal: true, detail: `${list(manifest.entries.map(describeEntry), 15)}\n\nFiles in the working copy are overwritten with the backed-up content; adds, deletes and renames are re-applied. Nothing is committed.` },
    'Restore',
  );
  if (ok !== 'Restore') return undefined;

  const release = repoLocks.tryAcquire(repo.name);
  if (!release) {
    void vscode.window.showWarningMessage(`Another Override operation is already running for "${repo.name}".`);
    return undefined;
  }
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Restoring override backup: ${repo.name}` }, (progress) =>
      restoreFromBackup({ svn: services.client, repoName: repo.name, wcRoot: repo.localFolder, backupDir: dir, timeoutMs: timeoutMs(), logger: services.logger, progress: (m) => progress.report({ message: m }) }),
    );
  } catch (e) {
    if (e instanceof SvnError && e.kind === 'cancelled') return repo.name;
    throw e;
  } finally {
    release();
  }
  const next = await vscode.window.showInformationMessage(`Backup restored into "${repo.name}". Review the changes and commit them when ready.`, 'Delete Backup', 'Keep');
  if (next === 'Delete Backup') await deleteBackup(dir);
  return repo.name;
}

import * as vscode from 'vscode';
import { RepoEntry } from '../repos/model';
import { originOf } from '../externals/model';
import { Services } from '../services';
import { reportError } from '../util/ui';

/** The working copy of the opened folder; throws a clear message when there is none. */
export function requireCurrent(services: Services): RepoEntry {
  const repo = services.repos.list()[0];
  if (!repo) throw new Error('The opened folder is not inside an SVN working copy. Use Checkout, or open a working copy folder.');
  return repo;
}

/** Username goes to global state and the password to SecretStorage, both per server origin. */
export async function setCredentials(services: Services): Promise<void> {
  const repo = requireCurrent(services);
  const server = originOf(repo.serverUrl) ?? repo.serverUrl;
  const hasPassword = await services.passwords.has(repo.serverUrl);
  const username = await vscode.window.showInputBox({ title: `Username for ${server}`, value: repo.username ?? '', ignoreFocusOut: true });
  if (username === undefined) return;
  const password = await vscode.window.showInputBox({
    title: `Password for ${server}`,
    prompt: hasPassword ? 'Leave empty to keep the stored password' : undefined,
    password: true,
    ignoreFocusOut: true,
  });
  if (password === undefined) return;
  if (password) await services.passwords.set(repo.serverUrl, password);
  if ((repo.username ?? '') !== username.trim()) await services.repos.update(repo.name, { ...repo, username: username.trim() || undefined });
  services.logger.info(`Credentials updated for ${server} (user: ${username.trim() || '<none>'})`);
  void vscode.window.showInformationMessage(`Credentials saved for ${server}.`);
}

/** Clears the stored password and username of the current repository's server. */
export async function clearCredentials(services: Services): Promise<void> {
  const repo = requireCurrent(services);
  const server = originOf(repo.serverUrl) ?? repo.serverUrl;
  await services.passwords.clear(repo.serverUrl);
  if (repo.username) await services.repos.update(repo.name, { ...repo, username: undefined });
  services.logger.info(`Credentials cleared for ${server}`);
  void vscode.window.showInformationMessage(`Credentials cleared for ${server}.`);
}

/** Checks the server connection of the current working copy. */
async function showRepoInfo(services: Services): Promise<void> {
  let repoName: string | undefined;
  try {
    const repo = requireCurrent(services);
    repoName = repo.name;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `SVN: ${repo.name}`, cancellable: true }, async (_p, token) => {
      const ac = new AbortController();
      token.onCancellationRequested(() => ac.abort());
      const local = await services.client.info(repo.localFolder, { signal: ac.signal });
      const remote = await services.client.info(repo.serverUrl, { repoName: repo.name, signal: ac.signal });
      services.output.appendLine(`Working copy ${repo.localFolder}: r${local.revision}, server HEAD r${remote.revision}, root ${remote.repositoryRoot}`);
      void vscode.window.showInformationMessage(`"${repo.name}": working copy r${local.revision}, server HEAD r${remote.revision}.`);
    });
  } catch (e) {
    await reportError(services, e, repoName);
  }
}

async function selectSvnPath(services: Services): Promise<void> {
  const r = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Use this svn.exe',
    filters: { 'svn.exe': ['exe'] },
    defaultUri: vscode.Uri.file('C:\\Program Files\\TortoiseSVN\\bin'),
  });
  if (!r?.[0]) return;
  await vscode.workspace.getConfiguration('svnWorkflow').update('svnPath', r[0].fsPath, vscode.ConfigurationTarget.Global);
  services.locator.invalidate();
  try {
    void vscode.window.showInformationMessage(`Using svn ${await services.client.version()}`);
  } catch (e) {
    await reportError(services, e);
  }
}

export function registerRepoCommands(context: vscode.ExtensionContext, services: Services): void {
  const reg = (id: string, fn: () => Promise<void>): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        try {
          await fn();
        } catch (e) {
          await reportError(services, e);
        }
      }),
    );
  };
  reg('svnWorkflow.setCredentials', () => setCredentials(services));
  reg('svnWorkflow.clearCredentials', () => clearCredentials(services));
  reg('svnWorkflow.showRepoInfo', () => showRepoInfo(services));
  reg('svnWorkflow.selectSvnPath', () => selectSvnPath(services));
  context.subscriptions.push(vscode.commands.registerCommand('svnWorkflow.showOutput', () => services.output.show(true)));
}

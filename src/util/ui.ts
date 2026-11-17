import * as vscode from 'vscode';
import { SvnError } from '../svn/errors';
import { NoRepoError } from '../repos/resolver';
import { Services } from '../services';
import { NoIncomingError } from '../incoming/model';
import { confirmCertificateTrust } from './trustUi';
import { BulkKind, bulkConfirmText } from './bulkConfirm';

const DOWNLOAD_URL = 'https://tortoisesvn.net/downloads.html';

/** Single place that turns errors into user-facing messages with next-step actions. */
export async function reportError(services: Services, err: unknown, repoName?: string): Promise<void> {
  if (err instanceof SvnError && err.kind === 'cancelled') return;
  const msg = err instanceof Error ? err.message : String(err);
  services.logger.error(msg);

  if (err instanceof SvnError) {
    switch (err.kind) {
      case 'svnNotFound': {
        const pick = await vscode.window.showErrorMessage(msg, 'Locate svn.exe', 'Open Settings', 'Download TortoiseSVN');
        if (pick === 'Locate svn.exe') await vscode.commands.executeCommand('svnWorkflow.selectSvnPath');
        else if (pick === 'Open Settings') await vscode.commands.executeCommand('workbench.action.openSettings', 'svnWorkflow.svnPath');
        else if (pick === 'Download TortoiseSVN') await vscode.env.openExternal(vscode.Uri.parse(DOWNLOAD_URL));
        return;
      }
      case 'auth': {
        const actions = repoName ? ['Set Credentials', 'Show Output'] : ['Show Output'];
        const pick = await vscode.window.showErrorMessage(`SVN authentication failed${repoName ? ` for "${repoName}"` : ''}: ${msg}`, ...actions);
        if (pick === 'Set Credentials') await vscode.commands.executeCommand('svnWorkflow.setCredentials');
        else if (pick === 'Show Output') services.output.show(true);
        return;
      }
      case 'certificate': {
        const repo = repoName ? services.repos.find(repoName) : undefined;
        const pick = await vscode.window.showErrorMessage(
          `${msg}. For a self-signed or internal certificate, trust it for ${repoName ? `"${repoName}"` : 'the repository'} (stored per server).`,
          ...(repo && !repo.trustServerCert && /^https:\/\//i.test(repo.serverUrl) ? ['Trust Certificate'] : []),
        );
        if (pick === 'Trust Certificate' && repo) {
          if (!/^https:\/\//i.test(repo.serverUrl)) {
            void vscode.window.showWarningMessage('Certificate trust only applies to https:// repositories.');
            return;
          }
          const c = await confirmCertificateTrust(repo.serverUrl);
          if (!c.trusted) return;
          await services.repos.update(repo.name, { ...repo, trustServerCert: true, trustedCertFingerprint: c.fingerprint });
          services.certs.reset(repo.name);
          services.incoming.requestRefresh({ repoName: repo.name, remote: true });
        }
        return;
      }
      case 'untrusted': {
        const pick = await vscode.window.showWarningMessage(msg, 'Manage Workspace Trust');
        if (pick) await vscode.commands.executeCommand('workbench.trust.manage');
        return;
      }
      case 'offline':
        void vscode.window.showErrorMessage(`SVN server unreachable (offline?): ${msg}`);
        return;
      case 'notWorkingCopy':
        void vscode.window.showErrorMessage(`Not an SVN working copy: ${msg}`);
        return;
      default:
        break;
    }
  }
  if (err instanceof NoRepoError || err instanceof NoIncomingError) {
    void vscode.window.showWarningMessage(msg);
    return;
  }
  const pick = await vscode.window.showErrorMessage(`SVN: ${msg}`, 'Show Output');
  if (pick) services.output.show(true);
}

/** Modal confirmation before updating a whole working copy or committing all changes. */
export async function confirmBulk(kind: BulkKind, repoName: string, folder: string, count: number): Promise<boolean> {
  const t = bulkConfirmText(kind, repoName, folder, count);
  return (await vscode.window.showWarningMessage(t.message, { modal: true, detail: t.detail }, t.action)) === t.action;
}

import * as vscode from 'vscode';
import type { RepoEntry } from '../repos/model';
import type { Services } from '../services';
import { reportError } from '../util/ui';
import { AuthEntry, authDirOf, deleteAuthEntries, describeAuthEntry, listAuthCache } from './model';

async function pickStoredRepo(services: Services, title: string): Promise<RepoEntry | undefined> {
  const repos = services.repos.list();
  if (!repos.length) {
    void vscode.window.showInformationMessage('SVN: no repositories are configured.');
    return undefined;
  }
  const items = await Promise.all(
    repos.map(async (r) => ({ label: r.name, description: r.serverUrl, detail: await credentialSummary(services, r), repo: r })),
  );
  return (await vscode.window.showQuickPick(items, { title, placeHolder: 'Repository' }))?.repo;
}

async function credentialSummary(services: Services, r: RepoEntry): Promise<string> {
  const pw = await services.passwords.has(r.serverUrl);
  return `user: ${r.username || '(none)'}   password: ${pw ? 'stored' : 'not stored'}${r.trustServerCert ? '   certificate trust: on' : ''}`;
}

async function clearRepo(services: Services, r: RepoEntry): Promise<void> {
  await services.passwords.clear(r.serverUrl);
  if (r.username) await services.repos.update(r.name, { ...r, username: undefined });
  services.logger.info(`Stored credentials cleared for "${r.name}"`);
}

function authDirOrThrow(): string {
  const d = authDirOf();
  if (!d) throw new Error('APPDATA is not set; cannot locate the Subversion auth cache.');
  return d;
}

export function registerAuth(context: vscode.ExtensionContext, services: Services): void {
  const reg = (id: string, fn: () => unknown): void => {
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

  reg('svnWorkflow.auth.list', async () => {
    const r = await pickStoredRepo(services, 'Stored credentials (extension secret storage). Select one to clear it.');
    if (!r) return;
    const ok = await vscode.window.showWarningMessage(`Clear the stored username and password of "${r.name}"?`, { modal: true }, 'Clear');
    if (!ok) return;
    await clearRepo(services, r);
    void vscode.window.showInformationMessage(`SVN: credentials of "${r.name}" cleared.`);
  });

  reg('svnWorkflow.auth.clearOne', async () => {
    const r = await pickStoredRepo(services, 'Clear stored credentials of which repository?');
    if (!r) return;
    await clearRepo(services, r);
    void vscode.window.showInformationMessage(`SVN: credentials of "${r.name}" cleared.`);
  });

  reg('svnWorkflow.auth.clearAll', async () => {
    const repos = services.repos.list();
    if (!repos.length) return;
    const ok = await vscode.window.showWarningMessage(
      `Clear the stored usernames and passwords of all ${repos.length} repositories?`,
      { modal: true, detail: repos.map((r) => r.name).join('\n') },
      'Clear All',
    );
    if (!ok) return;
    for (const r of repos) await clearRepo(services, r);
    void vscode.window.showInformationMessage(`SVN: credentials of ${repos.length} repositories cleared.`);
  });

  reg('svnWorkflow.auth.clearSvnCache', async () => {
    const dir = authDirOrThrow();
    const all = await listAuthCache(dir, services.repos.list());
    const mine = all.filter((e) => e.repos.length);
    if (!mine.length) {
      void vscode.window.showInformationMessage(`SVN: Subversion's own auth cache has nothing for the configured repositories (${dir}).`);
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Delete ${mine.length} cached Subversion credential file${mine.length === 1 ? '' : 's'} for the configured repositories?`,
      {
        modal: true,
        detail: `${mine.map((e) => `${e.kind}: ${describeAuthEntry(e)}  [${e.repos.join(', ')}]`).join('\n')}\n\nFolder: ${dir}\nThis also affects TortoiseSVN and svn.exe on this machine. The extension's own stored credentials are not touched.`,
      },
      'Delete',
    );
    if (!ok) return;
    const n = await deleteAuthEntries(dir, mine);
    services.logger.info(`Deleted ${n} svn auth cache file(s)`);
    void vscode.window.showInformationMessage(`SVN: deleted ${n} cached credential file${n === 1 ? '' : 's'}.`);
  });

  reg('svnWorkflow.auth.certs', async () => {
    const trusted = services.repos.list().filter((r) => r.trustServerCert);
    const dir = authDirOf();
    const cached: AuthEntry[] = dir ? (await listAuthCache(dir, services.repos.list())).filter((e) => e.kind === 'svn.ssl.server') : [];
    type Item = vscode.QuickPickItem & { repo?: RepoEntry; entry?: AuthEntry };
    const items: Item[] = [
      ...trusted.map((r): Item => ({ label: `$(shield) ${r.name}`, description: 'trustServerCert setting', detail: `${r.serverUrl}: accepts unknown-CA / hostname-mismatch certificates. Selecting turns the trust off.`, repo: r })),
      ...cached.map((e): Item => ({ label: `$(file-certificate) ${e.realm}`, description: "svn's cached certificate trust", detail: e.repos.length ? `Used by: ${e.repos.join(', ')}` : 'No configured repository', entry: e })),
    ];
    if (!items.length) {
      void vscode.window.showInformationMessage('SVN: no trusted certificates (no repository has trustServerCert and the Subversion cache has none).');
      return;
    }
    const picks = await vscode.window.showQuickPick(items, { canPickMany: true, title: 'Trusted server certificates', placeHolder: 'Select trust entries to remove (Esc to just look)' });
    if (!picks?.length) return;
    const ok = await vscode.window.showWarningMessage(`Remove ${picks.length} certificate trust entr${picks.length === 1 ? 'y' : 'ies'}?`, { modal: true, detail: picks.map((p) => p.label.replace(/^\$\([^)]+\)\s*/, '')).join('\n') }, 'Remove');
    if (!ok) return;
    for (const p of picks) if (p.repo) await services.repos.update(p.repo.name, { ...p.repo, trustServerCert: undefined, trustedCertFingerprint: undefined });
    const files = picks.flatMap((p) => (p.entry ? [p.entry] : []));
    if (dir && files.length) await deleteAuthEntries(dir, files);
    void vscode.window.showInformationMessage(`SVN: removed ${picks.length} certificate trust entr${picks.length === 1 ? 'y' : 'ies'}.`);
  });
}

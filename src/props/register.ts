import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { registerSvnCommand } from '../pane/commands';
import { groupPathsByRepo } from '../ops/targets';
import { RepoEntry } from '../repos/model';
import { Services } from '../services';
import { notifySuccess, runOperation } from '../util/notify';
import { reportError } from '../util/ui';
import { parseExternals } from './externals';
import { updateExternals } from './update';
import { FLAG_VALUE } from './model';
import { PropertiesPanel } from './panel';
import { applyChanges, getProp, listExternalsUnder } from './ops';
import { withRepoLockStrict } from '../util/repoCommand';

export function registerProps(context: vscode.ExtensionContext, services: Services): void {
  const tmpDir = path.join(context.globalStorageUri.fsPath, 'tmp');
  const ctxFor = (repo: RepoEntry, signal?: AbortSignal) => ({ client: services.client, repo, signal });

  registerSvnCommand(context, services, 'svnWorkflow.props.edit', (targets) => {
    const t = targets[0];
    if (!t) return;
    PropertiesPanel.show(context, services, t.repo, t.fsPath);
  });

  // Quick toggle for the common lock workflow (svn:needs-lock makes the file read-only until locked).
  registerSvnCommand(
    context,
    services,
    'svnWorkflow.props.toggleNeedsLock',
    async (targets) => {
      const files = targets.filter((t) => !fs.statSync(t.fsPath).isDirectory());
      if (!files.length) {
        void vscode.window.showWarningMessage('SVN: svn:needs-lock applies to files.');
        return;
      }
      const set = (await getProp(ctxFor(files[0].repo), files[0].fsPath, 'svn:needs-lock')) === undefined;
      for (const g of groupPathsByRepo(files).values()) {
        await withRepoLockStrict(g.repo.name, async () => {
          for (const p of g.paths) await applyChanges(ctxFor(g.repo), p, false, [{ name: 'svn:needs-lock', value: set ? FLAG_VALUE : undefined }], tmpDir);
        });
      }
      notifySuccess(services, `${set ? 'Set' : 'Removed'} svn:needs-lock on ${files.length} file${files.length === 1 ? '' : 's'}. Commit the property change to apply it for everyone.`);
    },
    { refreshAfter: true },
  );

  registerSvnCommand(context, services, 'svnWorkflow.externals.update', async (targets) => {
    await updateExternals(services, targets);
  }, { refreshAfter: true });

  context.subscriptions.push(
    vscode.commands.registerCommand('svnWorkflow.externals.list', async () => {
      try {
        const repos = services.repos.list();
        if (!repos.length) throw new Error('No repository is configured.');
        const repo = repos.length === 1 ? repos[0] : (await vscode.window.showQuickPick(repos.map((r) => ({ label: r.name, repo: r })), { placeHolder: 'List externals of which repository?' }))?.repo;
        if (!repo) return;
        const found = await runOperation('Listing externals', (signal) => listExternalsUnder(ctxFor(repo, signal), repo.localFolder));
        const items = found.flatMap((f) =>
          parseExternals(f.value).defs.map((d) => ({ label: `${d.dir}`, description: `${d.url}${d.peg ? `@${d.peg}` : ''}${d.rev ? ` -r${d.rev}` : ''}`, detail: path.resolve(repo.localFolder, f.dir), dir: path.resolve(repo.localFolder, f.dir) })),
        );
        if (!items.length) {
          void vscode.window.showInformationMessage(`SVN: no svn:externals in "${repo.name}".`);
          return;
        }
        const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Externals (pick one to edit the property of its folder)' });
        if (pick) PropertiesPanel.show(context, services, repo, pick.dir);
      } catch (e) {
        await reportError(services, e);
      }
    }),
  );
}

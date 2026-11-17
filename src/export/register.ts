import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { pickRevisionOf } from '../branch/register';
import { layoutOf, pickRef } from '../branch/ui';
import type { SvnTarget } from '../pane/commands';
import type { Services } from '../services';
import { runOperation } from '../util/notify';
import { registerRepoCommand } from '../util/repoCommand';
import { EXPORT_DEPTHS, EolStyle, ExportOptions } from './model';
import { runExport } from './ops';

async function exportFlow(services: Services, target: SvnTarget): Promise<void> {
  const { repo, fsPath } = target;
  const isFile = fs.existsSync(fsPath) && fs.statSync(fsPath).isFile();
  const info = await services.client.info(fsPath, { repoName: repo.name, cwd: repo.localFolder });
  const name = path.basename(fsPath) || repo.name;

  type Item = vscode.QuickPickItem & { id: 'wc' | 'rev' | 'other' };
  const what = await vscode.window.showQuickPick<Item>(
    [
      { id: 'wc', label: '$(folder) Working copy files', description: 'as on disk, with local changes, without .svn folders' },
      { id: 'rev', label: '$(history) This path at a revision...', description: info.url },
      { id: 'other', label: '$(git-branch) Another trunk / branch / tag...', description: 'its HEAD' },
    ],
    { title: `Export ${name}`, placeHolder: 'What should be exported?' },
  );
  if (!what) return;

  let source = fsPath;
  let rev: ExportOptions['rev'];
  let label = fsPath;
  let sourceIsFile = isFile;
  if (what.id === 'rev') {
    const r = await pickRevisionOf(services, repo, info.url);
    if (r === undefined) return;
    source = r === 'HEAD' ? info.url : `${info.url}@${r}`;
    rev = r;
    label = `${info.url}@${r}`;
  } else if (what.id === 'other') {
    const { layout } = await layoutOf(services, repo, fsPath);
    const ref = await pickRef(services, repo, layout, { title: 'Export which trunk, branch or tag?' });
    if (!ref) return;
    source = ref.url;
    rev = 'HEAD';
    label = ref.url;
    sourceIsFile = false;
  }

  const folder = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Export Here', title: `Export ${name} into folder` });
  if (!folder?.[0]) return;
  const picked = folder[0].fsPath;
  const dest = sourceIsFile ? path.join(picked, path.basename(source.replace(/@\d+$/, ''))) : picked;

  let depth: ExportOptions['depth'] = 'infinity';
  if (!sourceIsFile) {
    const d = await vscode.window.showQuickPick(EXPORT_DEPTHS.map((x) => ({ label: x.label, description: x.description, depth: x.depth })), { title: 'How much to export?' });
    if (!d) return;
    depth = d.depth;
  }
  const eol = await vscode.window.showQuickPick(
    [
      { label: 'Keep as stored', description: 'default', eol: 'default' as EolStyle },
      { label: 'Windows (CRLF)', description: 'for files with svn:eol-style native', eol: 'CRLF' as EolStyle },
      { label: 'Unix (LF)', description: 'for files with svn:eol-style native', eol: 'LF' as EolStyle },
      { label: 'Classic Mac (CR)', description: 'for files with svn:eol-style native', eol: 'CR' as EolStyle },
    ],
    { title: 'Line endings of exported files' },
  );
  if (!eol) return;
  const extra = await vscode.window.showQuickPick([{ label: 'Ignore externals', description: 'do not export svn:externals', id: 'ext' }], { title: 'More options', canPickMany: true, placeHolder: 'Press Enter to continue without any' });
  if (!extra) return;

  // svn refuses an existing destination without --force.
  let force = false;
  if (fs.existsSync(dest)) {
    const empty = fs.statSync(dest).isDirectory() && fs.readdirSync(dest).length === 0;
    if (!empty) {
      const ok = await vscode.window.showWarningMessage(`${dest} is not empty.`, { modal: true, detail: 'Exporting into it overwrites files with the same names. Other files stay.' }, 'Overwrite');
      if (ok !== 'Overwrite') return;
    }
    force = true;
  }

  const res = await runOperation(`Exporting ${name}`, (signal) =>
    runExport({ client: services.client, repo, signal }, { source, dest, rev, depth, eol: eol.eol, ignoreExternals: extra.length > 0, force }),
  );
  const choice = await vscode.window.showInformationMessage(`SVN: Exported ${label} to ${dest}${res.revision ? ` (r${res.revision})` : ''}.`, 'Reveal');
  services.logger.info(`Exported ${label} to ${dest}`);
  if (choice === 'Reveal') await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dest));
}

export function registerExport(context: vscode.ExtensionContext, services: Services): void {
  registerRepoCommand(context, services, 'svnWorkflow.export', (t) => exportFlow(services, t));
}

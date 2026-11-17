import * as path from 'node:path';
import * as vscode from 'vscode';
import { registerSvnCommand, type SvnTarget } from '../pane/commands';
import type { ItemNode } from '../pane/nodes';
import type { Services } from '../services';
import { openCompare, type CompareContext } from './panel';
import { IncomingContentProvider, INCOMING_SCHEME, incomingUri } from './provider';
import { pickRevision } from './revisions';
import { resolveCatTarget, type Rev } from './fetch';

export { openCompare } from './panel';
export type { CompareContext } from './panel';
export type { Source, CompareRequest } from './sources';

async function isDir(p: string): Promise<boolean> {
  return vscode.workspace.fs.stat(vscode.Uri.file(p)).then((s) => s.type === vscode.FileType.Directory, () => false);
}

/** Pane clicks share one compare tab. */
const PANE_COMPARE_KEY = 'pane';

/** Local file (left, editable) against the server at a revision (right). */
export async function compareLocalWithRev(ctx: CompareContext, t: { repoName: string; fsPath: string }, rev: Rev, deletedOnServer = false, reuseKey?: string): Promise<void> {
  const name = path.basename(t.fsPath);
  await openCompare(ctx, {
    left: { kind: 'local', fsPath: t.fsPath, repoName: t.repoName },
    right: deletedOnServer ? { kind: 'text', text: '', name, label: 'Server (deleted)' } : { kind: 'rev', repoName: t.repoName, target: t.fsPath, rev },
    editableSide: 'left',
    reuseKey,
    title: `${name} (Local ↔ ${rev === 'HEAD' ? 'Incoming' : `r${rev}`})`,
  });
}

/** Pane item click: incoming -> local vs HEAD; outgoing only -> local vs BASE (pulling from BASE reverts a hunk). */
export async function openItemCompare(ctx: CompareContext, node: ItemNode): Promise<void> {
  const { item, repo } = node;
  const file = vscode.Uri.file(item.path);
  const name = path.basename(item.path);
  if (item.item === 'unversioned' || item.item === 'added') {
    await vscode.commands.executeCommand('vscode.open', file);
    return;
  }
  if (item.item === 'missing' || item.item === 'deleted') {
    await vscode.commands.executeCommand('vscode.open', incomingUri(repo.name, item.path, 'BASE'));
    return;
  }
  if (await isDir(item.path)) {
    await vscode.commands.executeCommand('revealInExplorer', file);
    return;
  }
  if (item.incoming) {
    await compareLocalWithRev(ctx, { repoName: repo.name, fsPath: item.path }, 'HEAD', item.repoItem === 'deleted', PANE_COMPARE_KEY);
  } else if (item.outgoing) {
    await openCompare(ctx, {
      left: { kind: 'local', fsPath: item.path, repoName: repo.name },
      right: { kind: 'rev', repoName: repo.name, target: item.path, rev: 'BASE', label: 'BASE (last update)' },
      editableSide: 'left',
      reuseKey: PANE_COMPARE_KEY,
      title: `${name} (Working Copy ↔ BASE)`,
    });
  } else {
    await vscode.commands.executeCommand('vscode.open', file);
  }
}

export function registerCompare(context: vscode.ExtensionContext, services: Services): CompareContext {
  const ctx: CompareContext = { services, extensionUri: context.extensionUri };
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(INCOMING_SCHEME, new IncomingContentProvider(services)));

  const firstFile = async (targets: SvnTarget[]): Promise<SvnTarget | undefined> => {
    const t = targets[0];
    if (!t) return undefined;
    if (await isDir(t.fsPath)) {
      void vscode.window.showInformationMessage('Compare works on files. Select a file (folders list their files in the SVN pane).');
      return undefined;
    }
    return t;
  };

  registerSvnCommand(context, services, 'svnWorkflow.compareWithIncoming', async (targets) => {
    const t = await firstFile(targets);
    if (t) await compareLocalWithRev(ctx, { repoName: t.repo.name, fsPath: t.fsPath }, 'HEAD', t.item?.repoItem === 'deleted');
  });
  registerSvnCommand(context, services, 'svnWorkflow.compareWithRevision', async (targets) => {
    const t = await firstFile(targets);
    if (!t) return;
    const rev = await pickRevision(services, t.repo.name, await resolveCatTarget(services.client, t.repo.name, t.fsPath));
    if (rev !== undefined) await compareLocalWithRev(ctx, { repoName: t.repo.name, fsPath: t.fsPath }, rev);
  });
  return ctx;
}

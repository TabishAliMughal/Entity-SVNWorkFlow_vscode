import * as path from 'node:path';
import * as vscode from 'vscode';
import { openCompare, type CompareContext } from '../compare/panel';
import { contextLines } from '../patch/register';
import type { Services } from '../services';
import { notifySuccess, runOperation } from '../util/notify';
import { tmpDirOf, withRepoLock } from '../util/repoCommand';
import { registerSelectionCommand, type Selection } from '../util/selectionCommand';
import { ShelfInfo, parseShelveMode, validateShelfName } from './model';
import { ShelfCtx, deleteShelf, dirtyTargets, listShelves, nameTaken, previewShelf, shelve, unshelve } from './ops';
import { ShelfStore } from './store';

export function shelfCtx(context: vscode.ExtensionContext, services: Services, sel: Selection, signal?: AbortSignal): ShelfCtx {
  return {
    client: services.client,
    repo: sel.repo,
    store: new ShelfStore(path.join(context.globalStorageUri.fsPath, 'shelves')),
    tmpDir: tmpDirOf(context),
    mode: parseShelveMode(vscode.workspace.getConfiguration('svnWorkflow.shelve').get('mode')),
    context: contextLines(),
    signal,
    log: (m) => services.logger.info(m),
    confirmOverwrite: async (rels) =>
      (await vscode.window.showWarningMessage(
        `${rels.length} binary file(s) have local changes and cannot be merged.`,
        { modal: true, detail: `${rels.slice(0, 8).join('\n')}${rels.length > 8 ? '\n...' : ''}\n\nA copy of your local files is saved inside the shelf folder before they are replaced by the shelved versions.` },
        'Replace With Shelved',
      )) === 'Replace With Shelved',
  };
}

const stamp = (): string => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);

async function shelveFlow(context: vscode.ExtensionContext, services: Services, sel: Selection): Promise<void> {
  const probe = shelfCtx(context, services, sel);
  const name = await vscode.window.showInputBox({
    title: `Shelve changes of ${sel.repo.name}`,
    prompt: sel.whole ? 'Shelf name (shelves all changes)' : `Shelf name (shelves the ${sel.paths.length} selected path(s))`,
    value: `shelf-${stamp()}`,
    ignoreFocusOut: true,
    validateInput: validateShelfName,
  });
  if (!name) return;
  if (await nameTaken(probe, name.trim())) {
    void vscode.window.showErrorMessage(`SVN: A shelf named "${name.trim()}" already exists.`);
    return;
  }
  const message = await vscode.window.showInputBox({ title: 'Shelf message (optional)', prompt: 'Describe what is on this shelf', ignoreFocusOut: true });
  if (message === undefined) return;
  const res = await withRepoLock(sel.repo.name, () =>
    runOperation(`Shelving ${name.trim()}`, (signal) => shelve(shelfCtx(context, services, sel, signal), { name: name.trim(), message, paths: sel.paths })),
  );
  if (!res) return;
  for (const n of res.notes) services.logger.warn(n);
  notifySuccess(services, `Shelved ${res.files.length || 'all'} file(s) as "${name.trim()}" (${res.backend === 'native' ? 'native svn shelf, experimental' : 'patch shelf'}).${res.notes.length ? ` ${res.notes.join(' ')}` : ''}`);
}

async function pickShelf(c: ShelfCtx, title: string): Promise<ShelfInfo | undefined> {
  const list = await runOperation('Listing shelves', () => listShelves(c));
  if (!list.length) {
    void vscode.window.showInformationMessage(`SVN: There are no shelves for ${c.repo.name}.`);
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    list.map((s) => ({
      label: `$(archive) ${s.name}`,
      description: `${s.backend === 'native' ? 'native (experimental)' : 'patch'} - ${s.fileCount} file(s)${s.when ? ` - ${s.when.length > 20 ? s.when.slice(0, 16).replace('T', ' ') : s.when}` : ''}${s.broken ? ' - broken' : ''}`,
      detail: s.message.split(/\r?\n/)[0] || undefined,
      s,
    })),
    { title, placeHolder: 'Pick a shelf', matchOnDescription: true, matchOnDetail: true },
  );
  return pick?.s;
}

async function previewFlow(compare: CompareContext, c: ShelfCtx, info: ShelfInfo): Promise<void> {
  const files = await runOperation('Reading shelf', () => previewShelf(c, info));
  if (!files.length) {
    void vscode.window.showInformationMessage(`SVN: Shelf "${info.name}" has no previewable files.`);
    return;
  }
  for (;;) {
    const pick = await vscode.window.showQuickPick(
      files.map((f) => ({ label: `${f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : 'M'}  ${f.path}`, description: f.error, f })),
      { title: `Shelf "${info.name}": compare with BASE`, placeHolder: 'Select a file', matchOnDescription: true },
    );
    if (!pick) return;
    const f = pick.f;
    if (f.baseText === undefined || f.shelvedText === undefined) {
      void vscode.window.showInformationMessage(`SVN: ${f.path}: ${f.error ?? 'no text available'}`);
      continue;
    }
    const name = path.basename(f.path);
    await openCompare(compare, {
      left: { kind: 'text', text: f.baseText, name, label: f.status === 'added' ? 'BASE (does not exist)' : 'BASE' },
      right: { kind: 'text', text: f.shelvedText, name, label: f.status === 'deleted' ? 'Shelved (deleted)' : `Shelf ${info.name}` },
      title: `${name} (shelf ${info.name})`,
    });
  }
}

async function unshelveFlow(context: vscode.ExtensionContext, services: Services, sel: Selection, info: ShelfInfo, drop: boolean): Promise<void> {
  const dirty = await dirtyTargets(shelfCtx(context, services, sel), info);
  if (dirty.length) {
    const ok = await vscode.window.showWarningMessage(
      `${dirty.length} file(s) of this shelf already have local changes.`,
      { modal: true, detail: `${dirty.slice(0, 8).join('\n')}${dirty.length > 8 ? '\n...' : ''}\n\nUnshelving merges into them and may reject hunks.` },
      'Unshelve Anyway',
    );
    if (ok !== 'Unshelve Anyway') return;
  }
  const res = await withRepoLock(sel.repo.name, () => runOperation(`Unshelving ${info.name}`, (signal) => unshelve(shelfCtx(context, services, sel, signal), info, { drop })));
  if (!res) return;
  const notes = res.notes.length ? ` ${res.notes.join(' ')}` : '';
  if (res.conflicts.length) {
    const pick = await vscode.window.showWarningMessage(`SVN: Unshelved "${info.name}" with conflicts or rejected hunks in ${res.conflicts.join(', ')}. The shelf was kept.${notes}`, ...(res.rejects.length ? ['Open Rejects'] : []));
    if (pick) for (const r of res.rejects) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(r), { preview: false, preserveFocus: true });
    return;
  }
  notifySuccess(services, `Unshelved "${info.name}"${res.dropped ? ' and deleted the shelf' : ''}.${notes}`);
}

async function deleteFlow(context: vscode.ExtensionContext, services: Services, sel: Selection, info: ShelfInfo): Promise<void> {
  const ok = await vscode.window.showWarningMessage(`Delete shelf "${info.name}"?`, { modal: true, detail: 'The shelved changes are lost.' }, 'Delete');
  if (ok !== 'Delete') return;
  await withRepoLock(sel.repo.name, () => deleteShelf(shelfCtx(context, services, sel), info));
  notifySuccess(services, `Deleted shelf "${info.name}".`);
}

async function listFlow(context: vscode.ExtensionContext, services: Services, compare: CompareContext, sel: Selection): Promise<void> {
  const info = await pickShelf(shelfCtx(context, services, sel), `Shelves of ${sel.repo.name}`);
  if (!info) return;
  type Item = vscode.QuickPickItem & { id: 'preview' | 'keep' | 'drop' | 'delete' };
  const act = await vscode.window.showQuickPick<Item>(
    [
      { id: 'preview', label: '$(diff) Preview', description: 'compare each shelved file with BASE' },
      { id: 'keep', label: '$(debug-reverse-continue) Unshelve (keep the shelf)' },
      { id: 'drop', label: '$(check) Unshelve and delete the shelf' },
      { id: 'delete', label: '$(trash) Delete shelf' },
    ],
    { title: `Shelf "${info.name}"`, placeHolder: info.message.split(/\r?\n/)[0] || undefined },
  );
  if (!act) return;
  if (act.id === 'preview') await previewFlow(compare, shelfCtx(context, services, sel), info);
  else if (act.id === 'delete') await deleteFlow(context, services, sel, info);
  else await unshelveFlow(context, services, sel, info, act.id === 'drop');
}

export function registerShelve(context: vscode.ExtensionContext, services: Services, compare: CompareContext): void {
  registerSelectionCommand(context, services, 'svnWorkflow.shelve', (sel) => shelveFlow(context, services, sel), { refreshAfter: true });
  registerSelectionCommand(context, services, 'svnWorkflow.shelf.list', (sel) => listFlow(context, services, compare, sel), { refreshAfter: true });
  registerSelectionCommand(context, services, 'svnWorkflow.shelf.unshelve', async (sel) => {
    const info = await pickShelf(shelfCtx(context, services, sel), `Unshelve from ${sel.repo.name}`);
    if (info) await unshelveFlow(context, services, sel, info, false);
  }, { refreshAfter: true });
  registerSelectionCommand(context, services, 'svnWorkflow.shelf.delete', async (sel) => {
    const info = await pickShelf(shelfCtx(context, services, sel), `Delete a shelf of ${sel.repo.name}`);
    if (info) await deleteFlow(context, services, sel, info);
  });
  registerSelectionCommand(context, services, 'svnWorkflow.shelf.preview', async (sel) => {
    const info = await pickShelf(shelfCtx(context, services, sel), `Preview a shelf of ${sel.repo.name}`);
    if (info) await previewFlow(compare, shelfCtx(context, services, sel), info);
  });
}

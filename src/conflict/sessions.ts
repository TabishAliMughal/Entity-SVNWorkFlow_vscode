import * as path from 'node:path';
import * as vscode from 'vscode';
import { languageFor } from '../compare/langs';
import type { RepoEntry } from '../repos/model';
import type { Services } from '../services';
import { encodeText } from './encode';
import type { ConflictInfo } from './model';
import { applyProperty, conflictedProperties, loadOneConflict, loadTextInputs, readPrej, readPropertyValues, resolvePaths, type ConflictCtx } from './ops';
import type { MergeSession } from './panel';
import { withRepoLockStrict } from '../util/repoCommand';

const openUri = (p: string): Promise<void> => Promise.resolve(vscode.commands.executeCommand('vscode.open', vscode.Uri.file(p))).then(() => undefined);

export const ctxFor = (services: Services, repo: RepoEntry): ConflictCtx & { tmpDir: string } => ({ client: services.client, repo, tmpDir: services.tmpDir });

/** Refresh local state after a resolve; remote data is not needed. */
export async function refreshRepo(services: Services, repo: RepoEntry): Promise<void> {
  await services.incoming.refresh({ repoName: repo.name, remote: false });
}

async function writeWorkingFile(fsPath: string, text: string, encoding: Parameters<typeof encodeText>[1]): Promise<void> {
  const uri = vscode.Uri.file(fsPath);
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath.toLowerCase() === uri.fsPath.toLowerCase());
  if (doc) {
    const we = new vscode.WorkspaceEdit();
    we.replace(uri, doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0)), text);
    if (!(await vscode.workspace.applyEdit(we))) throw new Error('Could not write the merge result into the open editor.');
    await doc.save();
    return;
  }
  await vscode.workspace.fs.writeFile(uri, encodeText(text, encoding).bytes);
}

/** 3-way merge of a file with a text conflict: base / mine / theirs from the files svn left beside it. */
export function textSession(services: Services, repo: RepoEntry, filePath: string): MergeSession {
  const c = ctxFor(services, repo);
  const name = path.basename(filePath);
  let encoding: Parameters<typeof encodeText>[1] = 'utf-8';
  return {
    mode: 'text',
    key: `text:${filePath.toLowerCase()}`,
    title: `${name}: resolve conflict`,
    name,
    lang: languageFor(name),
    applyLabel: 'Save',
    resolveLabel: 'Save and mark resolved',
    async load() {
      const info = await loadOneConflict(c, filePath);
      if (!info?.text) throw new Error(`"${name}" no longer has a text conflict.`);
      const i = await loadTextInputs(info);
      encoding = i.encoding;
      return { base: i.base, mine: i.mine, theirs: i.theirs, labels: i.labels, encoding: i.encoding };
    },
    save: (text) => writeWorkingFile(filePath, text, encoding),
    async resolve() {
      // svn resolve clears every conflict of the node, not only the text one.
      const cur = await loadOneConflict(c, filePath);
      const other = [cur?.property && 'property', cur?.tree && 'tree'].filter(Boolean).join(' and ');
      if (other) {
        const ok = await vscode.window.showWarningMessage(`${name} also has a ${other} conflict.`, { modal: true, detail: 'Marking the file resolved clears that conflict too (the working value is kept). Resolve it first if you want to choose a value.' }, 'Mark All Resolved');
        if (ok !== 'Mark All Resolved') return false;
      }
      const r = await withRepoLockStrict(repo.name, () => resolvePaths(c, [filePath], 'working'));
      if (r.failed.length) throw new Error(r.failed[0].message);
      await refreshRepo(services, repo);
      void vscode.window.showInformationMessage(`SVN: ${name} marked as resolved.`);
      return true;
    },
    open: () => openUri(filePath),
  };
}

const show = (v: string | undefined): string => (v === undefined ? '' : v);

/** One session per conflicted property; the file is resolved when the last one is applied. */
export async function propertySessions(services: Services, repo: RepoEntry, filePath: string): Promise<MergeSession[]> {
  const c = ctxFor(services, repo);
  const info = await loadOneConflict(c, filePath);
  if (!info?.property) throw new Error(`"${path.basename(filePath)}" has no property conflict.`);
  const prej = await readPrej(info);
  const names = await conflictedProperties(c, info, prej);
  const remaining = new Set(names);
  const file = path.basename(filePath);
  return names.map((name): MergeSession => {
    let values: Awaited<ReturnType<typeof readPropertyValues>> | undefined;
    return {
      mode: 'property',
      key: `prop:${filePath.toLowerCase()}:${name}`,
      title: `${file}: property ${name}`,
      name: `${file} · ${name}`,
      notes: prej.trim() || undefined,
      applyLabel: 'Set property',
      resolveLabel: names.length > 1 ? 'Set property and resolve' : 'Set property and mark resolved',
      async load() {
        const cur: ConflictInfo | undefined = await loadOneConflict(c, filePath);
        if (!cur?.property) throw new Error(`"${file}" no longer has a property conflict.`);
        values = await readPropertyValues(c, cur, name);
        const note = (v: string | undefined, label: string): string => (v === undefined ? `${label} (property does not exist)` : label);
        return {
          base: show(values.base),
          mine: show(values.mine),
          theirs: show(values.theirs),
          labels: {
            base: note(values.base, 'Base (before the incoming change)'),
            mine: note(values.mine, 'Mine (working copy value)'),
            theirs: note(values.theirs, 'Theirs (incoming value)'),
          },
          encoding: 'utf-8',
        };
      },
      async save(result) {
        // An empty result deletes the property when one side did not have it; otherwise it sets an empty value.
        const deletes = result === '' && !!values && (values.mine === undefined || values.theirs === undefined);
        await withRepoLockStrict(repo.name, () => applyProperty(c, filePath, name, deletes ? undefined : result));
      },
      async resolve() {
        remaining.delete(name);
        if (remaining.size) {
          void vscode.window.showInformationMessage(`SVN: property ${name} set. ${remaining.size} more conflicted propert${remaining.size === 1 ? 'y' : 'ies'} on ${file}: resolve ${[...remaining].join(', ')}.`);
          return true;
        }
        const r = await withRepoLockStrict(repo.name, () => resolvePaths(c, [filePath], 'working'));
        if (r.failed.length) throw new Error(r.failed[0].message);
        await refreshRepo(services, repo);
        void vscode.window.showInformationMessage(`SVN: property conflict on ${file} resolved.`);
        return true;
      },
      open: () => openUri(filePath),
    };
  });
}

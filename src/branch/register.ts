import * as path from 'node:path';
import * as vscode from 'vscode';
import type { MergeEnv } from '../merge/register';
import { runMergeWizard } from '../merge/register';
import { localChangeCount } from '../merge/ops';
import type { SvnTarget } from '../pane/commands';
import type { RepoEntry } from '../repos/model';
import type { Services } from '../services';
import { parseLog } from '../svn/xml';
import { pegSafe } from '../svn/client';
import { notifySuccess, runOperation } from '../util/notify';
import { folderOf, registerRepoCommand, tmpDirOf, withRepoLock } from '../util/repoCommand';
import { notifyConflicts } from '../conflict/notice';
import { rebaseUrl } from '../wc/model';
import * as wcops from '../wc/ops';
import { joinSvnUrl } from '../util/svnUrl';
import { CopySource, Layout, defaultMessage, refUrl, validateRefName } from './model';
import { createRef, deleteUrl, urlExists } from './ops';
import { RefPick, layoutOf, listRefs, pickRef } from './ui';

const firstLine = (s?: string): string => (s ?? '').split(/\r?\n/)[0];

export async function pickRevisionOf(services: Services, repo: RepoEntry, url: string): Promise<number | 'HEAD' | undefined> {
  type Item = vscode.QuickPickItem & { rev?: number | 'HEAD'; manual?: boolean };
  const items: Item[] = [{ label: 'HEAD', description: 'latest on the server', rev: 'HEAD' }, { label: '$(edit) Enter revision number...', manual: true }];
  try {
    const r = await services.client.run(['log', '-l', '40', '--', pegSafe(url)], { repoName: repo.name, xml: true });
    for (const e of parseLog(r.text)) items.push({ label: `r${e.revision}`, description: `${e.author ?? ''} ${(e.date ?? '').slice(0, 10)}`.trim(), detail: firstLine(e.message), rev: e.revision });
  } catch (e) {
    services.logger.warn(`svn log for revision picker failed: ${(e as Error).message}`);
  }
  const pick = await vscode.window.showQuickPick(items, { title: `${url}: which revision?`, matchOnDescription: true, matchOnDetail: true });
  if (!pick) return undefined;
  if (!pick.manual) return pick.rev;
  const v = await vscode.window.showInputBox({ prompt: 'Revision number', validateInput: (s) => (/^\d+$/.test(s.trim()) ? undefined : 'Enter a number') });
  return v ? Number(v.trim()) : undefined;
}

async function createRefFlow(context: vscode.ExtensionContext, services: Services, target: SvnTarget, kind: 'branch' | 'tag'): Promise<void> {
  const { repo } = target;
  const dir = folderOf(target.fsPath);
  const { layout, url: wcUrl } = await layoutOf(services, repo, dir);
  const local = await localChangeCount({ client: services.client, repo, cwd: dir }, dir).catch(() => 0);

  type Item = vscode.QuickPickItem & { id: 'wc' | 'head' | 'rev' | 'other' };
  const src = await vscode.window.showQuickPick<Item>(
    [
      { id: 'wc', label: '$(folder) Working copy', description: local ? `includes ${local} local change(s)` : 'as it is on disk (no local changes)', detail: `copy ${path.basename(dir) || dir} to the new ${kind}` },
      { id: 'head', label: '$(cloud) Repository HEAD', description: wcUrl },
      { id: 'rev', label: '$(history) A specific revision...', description: wcUrl },
      { id: 'other', label: '$(git-branch) Another trunk / branch / tag...', description: 'its HEAD' },
    ],
    { title: `Create ${kind} from`, placeHolder: 'What should the new copy contain?' },
  );
  if (!src) return;

  let copy: CopySource;
  let srcLabel: string;
  if (src.id === 'wc') {
    copy = { kind: 'wc', path: dir };
    srcLabel = `the working copy of ${wcUrl}`;
  } else if (src.id === 'head') {
    copy = { kind: 'url', url: wcUrl, rev: 'HEAD' };
    srcLabel = wcUrl;
  } else if (src.id === 'rev') {
    const rev = await pickRevisionOf(services, repo, wcUrl);
    if (rev === undefined) return;
    copy = { kind: 'url', url: wcUrl, rev };
    srcLabel = `${wcUrl}@${rev}`;
  } else {
    const ref: RefPick | undefined = await pickRef(services, repo, layout, { title: `Source of the new ${kind}` });
    if (!ref) return;
    copy = { kind: 'url', url: ref.url, rev: 'HEAD' };
    srcLabel = ref.url;
  }

  const name = await vscode.window.showInputBox({
    title: `New ${kind} name`,
    prompt: `Created under ${kind === 'branch' ? layout.branches : layout.tags}/`,
    ignoreFocusOut: true,
    validateInput: validateRefName,
  });
  if (!name) return;
  const dest = refUrl(layout, kind, name);
  if (await urlExists({ client: services.client, repo }, dest)) {
    void vscode.window.showErrorMessage(`SVN: ${dest} already exists. Choose another name.`);
    return;
  }
  const message = await vscode.window.showInputBox({ title: 'Log message', value: defaultMessage(kind, name, srcLabel), ignoreFocusOut: true, validateInput: (s) => (s.trim() ? undefined : 'A message is required') });
  if (!message) return;

  if (copy.kind === 'wc' && local) {
    const ok = await vscode.window.showWarningMessage(
      `The working copy has ${local} local change(s).`,
      { modal: true, detail: `Copying the working copy to ${dest} includes them: the new ${kind} will contain your uncommitted edits, which are then also committed on the ${kind}. Choose "Repository HEAD" to copy only what is on the server.` },
      'Copy with Local Changes',
    );
    if (ok !== 'Copy with Local Changes') return;
  }

  const res = await runOperation(`Creating ${kind} ${name}`, (signal) => createRef({ client: services.client, repo, signal, tmpDir: tmpDirOf(context) }, copy, dest, message));
  const text = `Created ${kind} ${dest}${res.revision ? ` (r${res.revision})` : ''}.`;
  services.logger.info(text);
  const pick = await vscode.window.showInformationMessage(`SVN: ${text}`, 'Switch to It', 'Done');
  if (pick === 'Switch to It') await switchWc(services, repo, dir, dest);
}

/** Calls `svn switch` directly: the existing switch command is a picker and takes no URL argument. */
export async function switchWc(services: Services, repo: RepoEntry, fsPath: string, url: string): Promise<void> {
  const c = (signal?: AbortSignal) => ({ client: services.client, repo, signal });
  const before = await wcops.wcInfo(c(), fsPath);
  const r = await withRepoLock(repo.name, () => runOperation(`Switching to ${url}`, (signal) => wcops.switchTo(c(signal), fsPath, url)));
  if (!r) return;
  if (path.resolve(fsPath).toLowerCase() === path.resolve(repo.localFolder).toLowerCase()) await services.repos.update(repo.name, { ...repo, serverUrl: rebaseUrl(repo.serverUrl, before.url, url) });
  services.incoming.requestRefresh({ repoName: repo.name, remote: true });
  if (r.conflicts.length) await notifyConflicts(services, `Switched to ${url} with conflicts: ${r.conflicts.join(', ')}`);
  else notifySuccess(services, `Switched to ${url} (r${r.revision ?? '?'}).`);
}

async function deleteRefFlow(context: vscode.ExtensionContext, services: Services, repo: RepoEntry, layout: Layout, wcUrl: string, pick?: RefPick): Promise<void> {
  const ref = pick ?? (await pickRef(services, repo, layout, { title: 'Delete which branch or tag?', kinds: ['branch', 'tag'] }));
  if (!ref) return;
  const url = ref.url.replace(/\/+$/, '');
  if (ref.kind === 'trunk' || url === layout.trunk) {
    void vscode.window.showErrorMessage('SVN: trunk is not deleted from here.');
    return;
  }
  if (wcUrl.toLowerCase() === url.toLowerCase() || wcUrl.toLowerCase().startsWith(`${url.toLowerCase()}/`)) {
    void vscode.window.showErrorMessage(`SVN: this working copy is on ${url}. Switch it elsewhere before deleting it.`);
    return;
  }
  const ok = await vscode.window.showWarningMessage(`Delete ${url} from the repository?`, { modal: true, detail: 'This commits a server-side delete immediately. The history stays and the path can be restored by copying it from an earlier revision.' }, 'Delete');
  if (ok !== 'Delete') return;
  const message = await vscode.window.showInputBox({ title: 'Log message', value: `Delete ${ref.kind === 'custom' ? '' : `${ref.kind} `}${ref.name ?? url}`, ignoreFocusOut: true, validateInput: (s) => (s.trim() ? undefined : 'A message is required') });
  if (!message) return;
  const r = await runOperation(`Deleting ${url}`, (signal) => deleteUrl({ client: services.client, repo, signal, tmpDir: tmpDirOf(context) }, url, message));
  notifySuccess(services, `Deleted ${url}${r.revision ? ` (r${r.revision})` : ''}.`);
}

async function listFlow(context: vscode.ExtensionContext, services: Services, env: MergeEnv, target: SvnTarget): Promise<void> {
  const { repo } = target;
  const dir = folderOf(target.fsPath);
  const { layout, url: wcUrl } = await layoutOf(services, repo, dir);
  const refs = await listRefs(services, repo, layout);
  type Item = vscode.QuickPickItem & { ref?: RefPick };
  const items: Item[] = [];
  if (refs.trunk) items.push({ label: 'trunk', description: layout.trunk, ref: { url: layout.trunk, kind: 'trunk' } });
  if (refs.branches.length) items.push({ label: 'Branches', kind: vscode.QuickPickItemKind.Separator }, ...refs.branches.map((n) => ({ label: n, description: `${layout.branches}/${n}`, ref: { url: joinSvnUrl(layout.branches, n), kind: 'branch' as const, name: n } })));
  if (refs.tags.length) items.push({ label: 'Tags', kind: vscode.QuickPickItemKind.Separator }, ...refs.tags.map((n) => ({ label: n, description: `${layout.tags}/${n}`, ref: { url: joinSvnUrl(layout.tags, n), kind: 'tag' as const, name: n } })));
  if (!items.length) {
    void vscode.window.showInformationMessage(`SVN: no trunk, branches or tags found under ${layout.base}. Adjust svnWorkflow.layout.* if your layout differs.`);
    return;
  }
  const pick = await vscode.window.showQuickPick(items, { title: `Branches and tags (${layout.base})`, placeHolder: wcUrl === layout.trunk ? 'This working copy is on trunk' : `This working copy: ${wcUrl}` });
  if (!pick?.ref) return;
  const ref = pick.ref;
  const act = await vscode.window.showQuickPick(
    [
      { label: '$(arrow-swap) Switch working copy to it', id: 'switch' },
      { label: '$(git-merge) Merge it into the working copy...', id: 'merge' },
      { label: '$(copy) Copy URL', id: 'copy' },
      ...(ref.kind === 'trunk' ? [] : [{ label: '$(trash) Delete from repository...', id: 'delete' }]),
    ],
    { title: ref.url },
  );
  if (!act) return;
  if (act.id === 'switch') await switchWc(services, repo, dir, ref.url);
  else if (act.id === 'merge') await runMergeWizard(env, target, { source: ref.url });
  else if (act.id === 'copy') await vscode.env.clipboard.writeText(ref.url);
  else await deleteRefFlow(context, services, repo, layout, wcUrl, ref);
}

export function registerBranches(context: vscode.ExtensionContext, services: Services, env: MergeEnv): void {
  const reg = (id: string, h: (t: SvnTarget) => Promise<void>): void => registerRepoCommand(context, services, id, h, { refreshAfter: true });
  reg('svnWorkflow.createBranch', (t) => createRefFlow(context, services, t, 'branch'));
  reg('svnWorkflow.createTag', (t) => createRefFlow(context, services, t, 'tag'));
  reg('svnWorkflow.listBranches', (t) => listFlow(context, services, env, t));
  reg('svnWorkflow.deleteBranch', async (t) => {
    const dir = folderOf(t.fsPath);
    const { layout, url } = await layoutOf(services, t.repo, dir);
    await deleteRefFlow(context, services, t.repo, layout, url);
  });
}

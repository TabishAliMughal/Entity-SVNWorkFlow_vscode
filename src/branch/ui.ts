import * as vscode from 'vscode';
import { checkServerUrl } from '../repos/model';
import type { RepoEntry } from '../repos/model';
import type { Services } from '../services';
import { runOperation } from '../util/notify';
import { resolveSvnUrl } from '../wc/model';
import { Layout, LayoutSettings, detectLayout } from './model';
import { listDirs, urlExists } from './ops';

export function layoutSettings(): Partial<LayoutSettings> {
  const c = vscode.workspace.getConfiguration('svnWorkflow');
  return { base: c.get<string>('layout.base', ''), trunk: c.get<string>('layout.trunk', 'trunk'), branches: c.get<string>('layout.branches', 'branches'), tags: c.get<string>('layout.tags', 'tags') };
}

export async function layoutOf(services: Services, repo: RepoEntry, fsPath: string): Promise<{ layout: Layout; url: string; root: string }> {
  const info = await services.client.info(fsPath, { repoName: repo.name, cwd: repo.localFolder });
  return { layout: detectLayout(info.repositoryRoot, info.url, layoutSettings()), url: info.url.replace(/\/+$/, ''), root: info.repositoryRoot.replace(/\/+$/, '') };
}

export interface RefList {
  trunk: boolean;
  branches: string[];
  tags: string[];
}

export function listRefs(services: Services, repo: RepoEntry, layout: Layout): Promise<RefList> {
  return runOperation('Listing trunk, branches and tags', async (signal) => {
    const c = { client: services.client, repo, signal };
    const [trunk, branches, tags] = await Promise.all([urlExists(c, layout.trunk), listDirs(c, layout.branches), listDirs(c, layout.tags)]);
    return { trunk, branches, tags };
  });
}

export interface RefPick {
  url: string;
  kind: 'trunk' | 'branch' | 'tag' | 'custom';
  name?: string;
}

/** Quick pick over ^/trunk, ^/branches/* and ^/tags/*, or a typed URL / ^/path. */
export async function pickRef(
  services: Services,
  repo: RepoEntry,
  layout: Layout,
  o: { title: string; placeHolder?: string; exclude?: string; kinds?: Array<'trunk' | 'branch' | 'tag'> },
): Promise<RefPick | undefined> {
  const refs = await listRefs(services, repo, layout);
  const want = (k: 'trunk' | 'branch' | 'tag'): boolean => !o.kinds || o.kinds.includes(k);
  const skip = (u: string): boolean => !!o.exclude && u.toLowerCase() === o.exclude.replace(/\/+$/, '').toLowerCase();
  const caret = (u: string): string => (u.startsWith(layout.root) ? `^${u.slice(layout.root.length)}` : u);
  type Item = vscode.QuickPickItem & { pick?: RefPick; custom?: boolean };
  const items: Item[] = [];
  if (want('trunk') && refs.trunk && !skip(layout.trunk)) items.push({ label: 'trunk', description: caret(layout.trunk), pick: { url: layout.trunk, kind: 'trunk' } });
  const add = (title: string, kind: 'branch' | 'tag', base: string, names: string[]): void => {
    const rows = names.filter((n) => !skip(`${base}/${n}`));
    if (!rows.length) return;
    items.push({ label: title, kind: vscode.QuickPickItemKind.Separator }, ...rows.map((n) => ({ label: n, description: caret(`${base}/${n}`), pick: { url: `${base}/${n}`, kind, name: n } as RefPick })));
  };
  if (want('branch')) add('Branches', 'branch', layout.branches, refs.branches);
  if (want('tag')) add('Tags', 'tag', layout.tags, refs.tags);
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: '$(link) Enter a URL or ^/path...', custom: true });
  const p = await vscode.window.showQuickPick(items, { title: o.title, placeHolder: o.placeHolder ?? (items.length > 2 ? 'Pick one' : 'Nothing found under the standard layout; enter a URL'), matchOnDescription: true });
  if (!p) return undefined;
  if (p.pick) return p.pick;
  const v = await vscode.window.showInputBox({ title: o.title, prompt: 'Full URL or ^/path relative to the repository root', ignoreFocusOut: true, validateInput: (x) => checkServerUrl(resolveSvnUrl(x, layout.root)).error });
  if (!v) return undefined;
  return { url: resolveSvnUrl(v, layout.root), kind: 'custom' };
}

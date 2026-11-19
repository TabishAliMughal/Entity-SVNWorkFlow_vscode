import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ChangelistNode } from '../changelist/nodes';
import { groupByChangelist } from '../changelist/model';
import { formatCommitDate } from '../incoming/authors';
import { ChangeItem } from '../incoming/model';
import { RepoEntry } from '../repos/model';
import { lockCache } from '../locks/cache';
import { describeLock } from '../locks/model';
import { Services } from '../services';
import { conflictArtifacts, conflictFlags, conflictKinds, conflictedItems, kindsLabel } from '../conflict/model';
import { ConflictsNode, FolderNode, ItemNode, LocalIgnoreNode, MessageNode, PaneNode, RepoNode } from './nodes';
import { isSameOrUnder } from '../incoming/model';
import { TreeEntry, ViewMode, buildTree } from './tree';
import { iconFile, isDisplayOnly, paneIcon } from './icons';
import { DEFAULT_VISIBILITY, FILTER_TITLES, folderContextValue, PaneFilter, PaneVisibility, buildLabel, contextValueFor, filterItems, relativeDescription, statusText } from './model';

export class ChangesProvider implements vscode.TreeDataProvider<PaneNode> {
  private readonly emitter = new vscode.EventEmitter<PaneNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly lookups = new Set<string>();
  private authorTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly services: Services,
    private filter: PaneFilter,
    private mode: ViewMode = 'tree',
    private readonly extensionUri?: vscode.Uri,
    private visibility: PaneVisibility = DEFAULT_VISIBILITY,
  ) {}

  setVisibility(v: PaneVisibility): void {
    this.visibility = v;
    this.refresh();
  }

  getVisibility(): PaneVisibility {
    return this.visibility;
  }

  setViewMode(m: ViewMode): void {
    this.mode = m;
    this.refresh();
  }

  getViewMode(): ViewMode {
    return this.mode;
  }

  setFilter(f: PaneFilter): void {
    this.filter = f;
    this.refresh();
  }

  getFilter(): PaneFilter {
    return this.filter;
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  /** Counts for the view badge: incoming items across repos. */
  incomingCount(): number {
    return this.services.incoming.allItems().filter((i) => i.incoming).length;
  }

  dispose(): void {
    if (this.authorTimer) clearTimeout(this.authorTimer);
    this.emitter.dispose();
  }

  getChildren(node?: PaneNode): PaneNode[] {
    if (!node) return this.services.incoming.visibleRepos().map((r) => new RepoNode(r));
    if (node instanceof RepoNode) return this.repoChildren(node);
    if (node instanceof FolderNode) return this.entryNodes(node.repo, node.children);
    if (node instanceof ChangelistNode || node instanceof ConflictsNode) return this.itemNodes(node.repo, node.items);
    if (node instanceof LocalIgnoreNode) return this.itemNodes(node.repo, node.items, true);
    return [];
  }

  /** The opened (scoped) folder: the root of every path shown in the pane. */
  private rootOf(repo: RepoEntry): string {
    return this.services.incoming.scopeOf(repo)[0] ?? repo.localFolder;
  }

  private itemNodes(repo: RepoEntry, items: ChangeItem[], local = false): PaneNode[] {
    if (this.mode === 'list' || local) return items.map((i) => new ItemNode(repo, i, local));
    return this.entryNodes(repo, buildTree(items, this.rootOf(repo)));
  }

  private entryNodes(repo: RepoEntry, entries: TreeEntry[]): PaneNode[] {
    return entries.map((e) => (e.kind === 'item' ? new ItemNode(repo, e.item) : new FolderNode(repo, e.name, e.path, e.items, e.children)));
  }

  /** Listed paths of this working copy; shows the changed item when there is one, else a placeholder so the entry can still be removed. */
  private localIgnoreItems(repo: RepoEntry, ignored: ChangeItem[]): ChangeItem[] {
    const root = this.rootOf(repo);
    return this.services.localIgnore
      .paths()
      .filter((p) => isSameOrUnder(p, root))
      .map((p) => ignored.find((i) => i.path.toLowerCase() === p.toLowerCase()) ?? { repoName: repo.name, path: p, item: 'normal', props: 'none', outgoing: false, incoming: false })
      .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  }

  private repoChildren(node: RepoNode): PaneNode[] {
    const { incoming } = this.services;
    const state = incoming.getState(node.repo.name);
    if (!state) return [new MessageNode('Checking...', 'loading~spin')];
    const conflicts = conflictedItems(state.items).sort((a, b) => relativeDescription(a.path, this.rootOf(node.repo)).localeCompare(relativeDescription(b.path, this.rootOf(node.repo)), undefined, { sensitivity: 'base' }));
    const artifacts = conflictArtifacts(state.items);
    const items = filterItems(state.items.filter((i) => !artifacts.has(i) && !conflicts.includes(i)), this.filter, this.visibility).sort((a, b) => relativeDescription(a.path, this.rootOf(node.repo)).localeCompare(relativeDescription(b.path, this.rootOf(node.repo)), undefined, { sensitivity: 'base' }));
    this.prefetchAuthors(node, items, state.youngest);
    const out: PaneNode[] = [];
    if (state.error) out.push(new MessageNode(`Could not check server: ${state.error.kind}`, 'warning', state.error.message));
    if (conflicts.length) out.push(new ConflictsNode(node.repo, conflicts));
    if (!items.length && !conflicts.length && !state.error) out.push(new MessageNode(`No ${FILTER_TITLES[this.filter].toLowerCase()} changes`, 'check'));
    // Changelists present: a default "Changes" group plus one group per changelist; otherwise the list stays flat.
    const listed = this.localIgnoreItems(node.repo, state.ignored);
    const tail = listed.length ? [new LocalIgnoreNode(node.repo, listed)] : [];
    const groups = groupByChangelist(items, true);
    if (groups.length) return out.concat(groups.map((g) => new ChangelistNode(node.repo, g.title, g.changelist, g.items)), tail);
    return out.concat(this.itemNodes(node.repo, items), tail);
  }

  private prefetchAuthors(node: RepoNode, items: ChangeItem[], youngest: number | undefined): void {
    const { authors } = this.services;
    const todo = items.filter((i) => !authors.has(i, youngest));
    if (!todo.length || this.lookups.has(node.repo.name)) return;
    this.lookups.add(node.repo.name);
    void authors
      .lookup(node.repo, todo, youngest)
      .then((gained) => {
        if (!gained) return;
        if (this.authorTimer) clearTimeout(this.authorTimer);
        this.authorTimer = setTimeout(() => this.refresh(), 150);
      })
      .catch((e) => this.services.logger.warn(`Author lookup failed: ${(e as Error).message}`))
      .finally(() => this.lookups.delete(node.repo.name));
  }

  getTreeItem(node: PaneNode): vscode.TreeItem {
    if (node instanceof MessageNode) {
      const t = new vscode.TreeItem(node.text);
      t.iconPath = node.icon ? new vscode.ThemeIcon(node.icon) : undefined;
      t.tooltip = node.tooltip;
      t.contextValue = 'svnMessage';
      return t;
    }
    if (node instanceof RepoNode) return this.repoItem(node);
    if (node instanceof ChangelistNode) return this.groupItem(node);
    if (node instanceof ConflictsNode) return this.conflictsGroup(node);
    if (node instanceof LocalIgnoreNode) return this.localIgnoreGroup(node);
    if (node instanceof FolderNode) return this.folderItem(node);
    return this.changeItem(node);
  }

  private repoItem(node: RepoNode): vscode.TreeItem {
    const state = this.services.incoming.getState(node.repo.name);
    const root = this.rootOf(node.repo);
    const t = new vscode.TreeItem(path.basename(root) || root, vscode.TreeItemCollapsibleState.Expanded);
    t.id = `svnRepo:${node.repo.name}`;
    const out = state?.items.filter((i) => i.outgoing).length ?? 0;
    const inc = state?.items.filter((i) => i.incoming).length ?? 0;
    const bits = [`${out} outgoing`, `${inc} incoming`];
    if (state?.error) bits.push(state.error.kind === 'offline' ? 'offline' : 'check failed');
    t.description = state ? bits.join(', ') : undefined;
    t.iconPath = new vscode.ThemeIcon('repo');
    t.contextValue = ['svnRepo', out ? 'outgoing' : '', inc ? 'incoming' : '', state?.items.some((i) => conflictKinds(i).length) ? 'conflicted' : ''].filter(Boolean).join(' ');
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${path.basename(root) || root}**\n\nRepository: ${node.repo.name}\n\n${node.repo.serverUrl}\n\n\`${root}\``);
    if (state?.remoteCheckedAt) md.appendMarkdown(`\n\nServer checked: ${new Date(state.remoteCheckedAt).toLocaleTimeString()}${state.youngest ? ` (HEAD r${state.youngest})` : ''}`);
    if (state?.error) md.appendMarkdown(`\n\n$(warning) ${state.error.message}`);
    t.tooltip = md;
    return t;
  }

  private conflictsGroup(node: ConflictsNode): vscode.TreeItem {
    const t = new vscode.TreeItem('Conflicts', vscode.TreeItemCollapsibleState.Expanded);
    t.id = `svnConflicts:${node.repo.name}`;
    t.description = `${node.items.length}`;
    t.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.errorForeground'));
    t.contextValue = 'svnConflicts';
    t.tooltip = `${node.items.length} conflicted item${node.items.length === 1 ? '' : 's'}: resolve them before committing.`;
    return t;
  }

  private localIgnoreGroup(node: LocalIgnoreNode): vscode.TreeItem {
    const t = new vscode.TreeItem('Local Ignore List', vscode.TreeItemCollapsibleState.Expanded);
    t.id = `svnLocalIgnore:${node.repo.name}`;
    t.description = `${node.items.length}`;
    t.iconPath = new vscode.ThemeIcon('eye-closed');
    t.contextValue = 'svnLocalIgnoreGroup';
    t.tooltip = 'Kept on this machine only (never svn:ignore, never committed). These files are skipped by Commit, Update and every bulk action.';
    return t;
  }

  private folderItem(node: FolderNode): vscode.TreeItem {
    const t = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
    t.id = `svnFolder:${node.repo.name}:${node.path}`;
    t.iconPath = vscode.ThemeIcon.Folder;
    t.resourceUri = vscode.Uri.file(node.path);
    t.description = `${node.items.length}`;
    t.contextValue = folderContextValue(node.items);
    t.tooltip = `${node.path}
${node.items.length} change${node.items.length === 1 ? '' : 's'}`;
    return t;
  }

  private groupItem(node: ChangelistNode): vscode.TreeItem {
    const t = new vscode.TreeItem(node.title, vscode.TreeItemCollapsibleState.Expanded);
    t.id = `svnChangelist:${node.repo.name}:${node.changelist ?? ''}`;
    t.description = `${node.items.length}`;
    t.iconPath = new vscode.ThemeIcon(node.changelist ? 'checklist' : 'files');
    t.contextValue = node.changelist ? 'svnChangelist namedChangelist' : 'svnChangelist defaultGroup';
    t.tooltip = node.changelist ? `Changelist "${node.changelist}" (${node.items.length} file${node.items.length === 1 ? '' : 's'})` : 'Changes that are not in a changelist';
    return t;
  }

  private changeItem(node: ItemNode): vscode.TreeItem {
    const { item, repo } = node;
    const youngest = this.services.incoming.getState(repo.name)?.youngest;
    const stamp = this.services.authors.getStamp(item, youngest);
    const author = stamp?.author;
    const date = formatCommitDate(stamp?.date);
    const name = path.basename(item.path);
    const t = new vscode.TreeItem(buildLabel(name, author));
    const icon = paneIcon(item);
    t.iconPath = isDisplayOnly(item)
      ? new vscode.ThemeIcon('eye-closed', new vscode.ThemeColor('disabledForeground'))
      : this.extensionUri
      ? { light: vscode.Uri.joinPath(this.extensionUri, iconFile(icon, 'light')), dark: vscode.Uri.joinPath(this.extensionUri, iconFile(icon, 'dark')) }
      : new vscode.ThemeIcon('circle-outline');
    const dir = this.mode === 'list' ? relativeDescription(path.dirname(item.path), this.rootOf(repo)) : '';
    t.description = dir || undefined;
    t.resourceUri = vscode.Uri.file(item.path);
    let isDir = false;
    try {
      isDir = fs.statSync(item.path).isDirectory();
    } catch {
      /* missing or remote-only */
    }
    t.contextValue = node.local ? `svnLocalIgnored ${isDir ? 'dir' : 'file'}` : [contextValueFor(item, isDir), ...conflictFlags(item)].join(' ');
    const kinds = conflictKinds(item);
    if (kinds.length) t.description = `${t.description ? `${t.description} ` : ''}(${kindsLabel(kinds)} conflict)`;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${name}**\n\n\`${item.path}\`\n\n${statusText(item)}`);
    if (author) md.appendMarkdown(`\n\nLast committer: ${author}${date ? ` (${date})` : ''}`);
    if (item.revision !== undefined) md.appendMarkdown(`\n\nBASE r${item.revision}`);
    if (item.changelist) md.appendMarkdown(`\n\nChangelist: ${item.changelist}`);
    const lock = lockCache.get(repo.name, item.path);
    if (lock.state !== 'none') md.appendMarkdown(`\n\n$(lock) ${describeLock(lock)}`);
    md.appendMarkdown(`\n\nRepository: ${repo.name}`);
    t.tooltip = md;
    t.command = node.local
      ? { command: 'svnWorkflow.pane.openFile', title: 'Open File', arguments: [node] }
      : kinds.length
      ? { command: 'svnWorkflow.conflict.resolve', title: 'Resolve Conflict', arguments: [node] }
      : { command: 'svnWorkflow.pane.openDiff', title: 'Open Diff', arguments: [node] };
    return t;
  }
}

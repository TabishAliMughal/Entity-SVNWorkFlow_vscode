import * as path from 'node:path';
import * as vscode from 'vscode';
import { collectTargets } from '../pane/commands';
import { ChangeItem, aggregateIncoming, pathKey } from '../incoming/model';
import type { RepoEntry } from '../repos/model';
import type { Services } from '../services';
import { notifySuccess, notifyWarning, runOperation } from '../util/notify';
import { reportError } from '../util/ui';
import {
  ACCEPT_CHOICES,
  conflictKinds,
  conflictedItems,
  expandToConflicted,
  kindsLabel,
  relativeTo,
  summarizeConflicts,
  type AcceptChoice,
  type ConflictKind,
} from './model';
import { resolvePaths } from './ops';
import { capPathKeys } from '../util/pathKeys';
import { withRepoLockStrict } from '../util/repoCommand';
import { operationToastedRecently } from './notice';
import { openMergeEditor, type MergeContext } from './panel';
import { ctxFor, propertySessions, refreshRepo, textSession } from './sessions';
import { resolveTreeConflict } from './tree';

const setContext = (key: string, value: unknown): void => void vscode.commands.executeCommand('setContext', key, value);
const KIND_TITLE: Record<ConflictKind, string> = { text: 'Text conflict (3-way merge editor)', property: 'Property conflict', tree: 'Tree conflict' };

export function registerConflicts(context: vscode.ExtensionContext, services: Services, mergeCtx: MergeContext): void {
  const repoOf = (name: string): RepoEntry | undefined => services.repos.list().find((r) => r.name === name);
  const allConflicts = (): ChangeItem[] => conflictedItems(services.incoming.allItems());

  const reg = (id: string, fn: (arg?: unknown, selection?: unknown) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (arg?: unknown, selection?: unknown) => {
        try {
          await fn(arg, selection);
        } catch (e) {
          await reportError(services, e);
        }
      }),
    );
  };

  const describe = (i: ChangeItem): vscode.QuickPickItem & { item: ChangeItem } => {
    const repo = repoOf(i.repoName);
    return { label: `$(warning) ${repo ? relativeTo(repo.localFolder, i.path) : path.basename(i.path)}`, description: kindsLabel(conflictKinds(i)), detail: i.repoName, item: i };
  };

  /** Conflicted items covered by the command arguments (pane items, Explorer/editor selection, repo or folder). */
  const targetsToItems = (arg?: unknown, selection?: unknown): ChangeItem[] => {
    let targets: { fsPath: string }[] = [];
    try {
      targets = collectTargets(services, arg, selection);
    } catch {
      /* palette without a file: fall through to the picker */
    }
    const conflicts = allConflicts();
    const paths = expandToConflicted(targets.map((t) => t.fsPath), conflicts.map((c) => c.path));
    const keys = new Set(paths.map((p) => pathKey(p)));
    return conflicts.filter((c) => keys.has(pathKey(c.path)));
  };

  const pickItems = async (placeHolder: string, many: boolean): Promise<ChangeItem[]> => {
    const all = allConflicts();
    if (!all.length) {
      void vscode.window.showInformationMessage('SVN: there are no conflicts.');
      return [];
    }
    const picks = await vscode.window.showQuickPick(all.map(describe), { placeHolder, canPickMany: many, matchOnDescription: true, matchOnDetail: true });
    return !picks ? [] : (Array.isArray(picks) ? picks : [picks]).map((p) => p.item);
  };

  const itemsFor = async (arg: unknown, selection: unknown, placeHolder: string, many = true): Promise<ChangeItem[]> => {
    const items = targetsToItems(arg, selection);
    return items.length ? items : pickItems(placeHolder, many);
  };

  // ---------- resolve one item (editor / tree / property) ----------
  const resolveOne = async (item: ChangeItem): Promise<void> => {
    const repo = repoOf(item.repoName);
    if (!repo) throw new Error(`Repository "${item.repoName}" is not configured.`);
    const kinds = conflictKinds(item);
    let kind = kinds[0];
    if (kinds.length > 1) {
      const pick = await vscode.window.showQuickPick(
        kinds.map((k) => ({ label: KIND_TITLE[k], ck: k })),
        { placeHolder: `${path.basename(item.path)} has several conflicts. Which one first?` },
      );
      if (!pick) return;
      kind = pick.ck;
    }
    if (kind === 'text') await openMergeEditor(mergeCtx, textSession(services, repo, item.path));
    else if (kind === 'property') for (const s of await propertySessions(services, repo, item.path)) await openMergeEditor(mergeCtx, s);
    else if (kind === 'tree') await resolveTreeConflict(services, repo, item.path);
  };

  reg('svnWorkflow.conflict.resolve', async (arg, selection) => {
    const items = await itemsFor(arg, selection, 'Conflicted item to resolve');
    for (const i of items) await resolveOne(i);
  });
  reg('svnWorkflow.conflict.edit', async (arg, selection) => {
    for (const i of (await itemsFor(arg, selection, 'Conflicted file')).filter((c) => conflictKinds(c).includes('text'))) {
      const repo = repoOf(i.repoName);
      if (repo) await openMergeEditor(mergeCtx, textSession(services, repo, i.path));
    }
  });
  reg('svnWorkflow.conflict.props', async (arg, selection) => {
    for (const i of (await itemsFor(arg, selection, 'Item with a property conflict')).filter((c) => conflictKinds(c).includes('property'))) {
      const repo = repoOf(i.repoName);
      if (repo) for (const s of await propertySessions(services, repo, i.path)) await openMergeEditor(mergeCtx, s);
    }
  });
  reg('svnWorkflow.conflict.tree', async (arg, selection) => {
    for (const i of (await itemsFor(arg, selection, 'Item with a tree conflict')).filter((c) => conflictKinds(c).includes('tree'))) {
      const repo = repoOf(i.repoName);
      if (repo) await resolveTreeConflict(services, repo, i.path);
    }
  });

  // ---------- quick actions without the editor ----------
  const CONFIRM: Partial<Record<AcceptChoice, string>> = {
    'mine-full': 'Your version of the whole file is kept; all incoming changes to it are lost.',
    'theirs-full': 'The incoming version of the whole file is taken; all your changes to it are lost.',
    base: 'Both your changes and the incoming changes are discarded; the common ancestor is restored.',
  };

  const accept = async (items: ChangeItem[], choice: AcceptChoice): Promise<void> => {
    if (!items.length) return;
    const meta = ACCEPT_CHOICES.find((c) => c.id === choice) as (typeof ACCEPT_CHOICES)[number];
    const warn = CONFIRM[choice];
    if (warn) {
      const names = items.slice(0, 12).map((i) => `  ${path.basename(i.path)}`).join('\n') + (items.length > 12 ? `\n  ... and ${items.length - 12} more` : '');
      const ok = await vscode.window.showWarningMessage(`${meta.label}: ${items.length} item${items.length === 1 ? '' : 's'}?`, { modal: true, detail: `${warn}\n\n${names}` }, 'Resolve');
      if (ok !== 'Resolve') return;
    }
    const byRepo = new Map<string, ChangeItem[]>();
    for (const i of items) byRepo.set(i.repoName, [...(byRepo.get(i.repoName) ?? []), i]);
    const out = await runOperation(`Resolving conflicts (${meta.id})`, async (signal, step) => {
      let resolved = 0;
      const failed: string[] = [];
      for (const [name, list] of byRepo) {
        const repo = repoOf(name);
        if (!repo) continue;
        step(name);
        const r = await withRepoLockStrict(repo.name, () => resolvePaths({ ...ctxFor(services, repo), signal }, list.map((i) => i.path), choice));
        resolved += r.resolved.length;
        failed.push(...r.failed.map((f) => `${relativeTo(repo.localFolder, f.path)}: ${f.message}`));
      }
      return { resolved, failed };
    }).finally(async () => {
      for (const name of byRepo.keys()) {
        const repo = repoOf(name);
        if (repo) await refreshRepo(services, repo);
      }
    });
    if (out.resolved) notifySuccess(services, `Resolved ${out.resolved} conflict${out.resolved === 1 ? '' : 's'} (${meta.id}).`);
    if (out.failed.length) await notifyWarning(services, `${out.failed.length} not resolved:\n${out.failed.slice(0, 8).join('\n')}`);
  };

  for (const c of ACCEPT_CHOICES) {
    reg(c.command, async (arg, selection) => accept(await itemsFor(arg, selection, `Conflicts to resolve: ${c.label}`), c.id));
  }
  reg('svnWorkflow.conflict.accept', async (arg, selection) => {
    const items = await itemsFor(arg, selection, 'Conflicts to resolve');
    if (!items.length) return;
    const pick = await vscode.window.showQuickPick(
      ACCEPT_CHOICES.map((c) => ({ label: c.label, detail: c.detail, id: c.id })),
      { title: `Resolve ${items.length} conflict${items.length === 1 ? '' : 's'}`, placeHolder: 'How should they be resolved?', matchOnDetail: true },
    );
    if (pick) await accept(items, pick.id);
  });
  reg('svnWorkflow.conflict.acceptAll', async () => {
    const repos = [...new Set(allConflicts().map((i) => i.repoName))];
    if (!repos.length) {
      void vscode.window.showInformationMessage('SVN: there are no conflicts.');
      return;
    }
    const name = repos.length === 1 ? repos[0] : (await vscode.window.showQuickPick(repos, { placeHolder: 'Resolve all conflicts of which repository?' }));
    if (!name) return;
    const items = allConflicts().filter((i) => i.repoName === name);
    const pick = await vscode.window.showQuickPick(
      ACCEPT_CHOICES.map((c) => ({ label: c.label, detail: c.detail, id: c.id })),
      { title: `Resolve all ${items.length} conflicts in ${name}`, matchOnDetail: true },
    );
    if (pick) await accept(items, pick.id);
  });

  reg('svnWorkflow.conflict.list', async () => {
    const all = allConflicts();
    if (!all.length) {
      void vscode.window.showInformationMessage('SVN: there are no conflicts.');
      return;
    }
    const reveal = { label: '$(list-tree) Show in the SVN pane', item: undefined as ChangeItem | undefined };
    const pick = await vscode.window.showQuickPick([reveal, ...all.map(describe)], { placeHolder: `${all.length} conflict${all.length === 1 ? '' : 's'}: pick one to resolve`, matchOnDescription: true });
    if (!pick) return;
    if (!pick.item) await vscode.commands.executeCommand('svnWorkflow.pane.focus');
    else await resolveOne(pick.item);
  });
  reg('svnWorkflow.conflict.show', () => vscode.commands.executeCommand('svnWorkflow.pane.focus'));

  // ---------- status bar, context keys, notifications ----------
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  bar.name = 'SVN Conflicts';
  bar.command = 'svnWorkflow.conflict.list';
  const known = new Set<string>();
  const seenRepos = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fresh: ChangeItem[] = [];

  const publish = (): void => {
    const items = allConflicts();
    const sum = summarizeConflicts(items);
    if (sum.total) {
      bar.text = `$(warning) ${sum.total} conflict${sum.total === 1 ? '' : 's'}`;
      const parts = [sum.text && `${sum.text} text`, sum.property && `${sum.property} property`, sum.tree && `${sum.tree} tree`].filter(Boolean);
      bar.tooltip = `SVN conflicts: ${parts.join(', ')}. Click to resolve.`;
      bar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      bar.show();
    } else bar.hide();
    setContext('svnWorkflow.hasConflicts', sum.total > 0);
    const keys: string[] = [];
    for (const repo of services.repos.list()) {
      const paths = items.filter((i) => i.repoName === repo.name).map((i) => i.path);
      if (paths.length) keys.push(...aggregateIncoming(paths, repo.localFolder).map((p) => vscode.Uri.file(p).fsPath));
    }
    setContext('svnWorkflow.conflictedPaths', capPathKeys('svnWorkflow.conflictedPaths', keys, services.logger));

    const current = new Set(items.map((i) => pathKey(i.path)));
    // Conflicts already present when a repo's first status arrives are not "new".
    const added = items.filter((i) => !known.has(pathKey(i.path)) && seenRepos.has(i.repoName));
    known.clear();
    for (const k of current) known.add(k);
    for (const st of services.incoming.allStates()) seenRepos.add(st.repoName);
    if (!added.length) return;
    fresh.push(...added);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const list = fresh.filter((i) => known.has(pathKey(i.path)));
      fresh = [];
      // An update/merge command shows its own conflict warning; do not repeat it.
      if (!list.length || operationToastedRecently()) return;
      void vscode.window
        .showWarningMessage(`SVN: ${list.length} new conflict${list.length === 1 ? '' : 's'} in the working copy.`, 'Resolve Conflicts')
        .then((p) => (p ? vscode.commands.executeCommand('svnWorkflow.conflict.list') : undefined));
    }, 1500);
  };

  context.subscriptions.push(
    bar,
    { dispose: () => clearTimeout(timer) },
    services.incoming.onDidChange(publish),
    services.repos.onDidChange(publish),
  );
  publish();
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isSameOrUnder } from '../incoming/model';
import { expandUpdatePaths } from '../localignore/model';
import { requireIncoming } from '../incoming/guard';
import { escapeGlob, extensionPattern, globMatches } from '../ops/ignore';
import { AddDepth, addIgnore, addPaths, deleteKeepLocal, isUnversioned, overrideUpdate, readIgnore, removeIgnorePatterns, updatePaths } from '../ops/svnOps';
import { groupPathsByRepo, summarizePaths } from '../ops/targets';
import { RepoEntry } from '../repos/model';
import { SvnTarget, registerSvnCommand } from '../pane/commands';
import { Services } from '../services';
import { SvnError } from '../svn/errors';
import { notifySuccess, runOperation } from '../util/notify';
import { notifyConflicts } from '../conflict/notice';
import { confirmBulk, reportError } from '../util/ui';
import { createCommitFeature } from '../commit/register';
import { withRepoLocks } from './wcCommands';


const rel = (repo: RepoEntry, p: string): string => path.relative(repo.localFolder, p).split(path.sep).join('/') || `(${repo.name} root)`;
const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export function registerWorkflowCommands(context: vscode.ExtensionContext, services: Services): void {
  const ctxFor = (repo: RepoEntry, signal?: AbortSignal) => ({ client: services.client, repo, signal, tmpDir: services.tmpDir });
  // Mutating commands refuse while another SVN operation holds the repo lock.
  const guarded = (h: (t: SvnTarget[]) => unknown | Promise<unknown>) => (targets: SvnTarget[]): Promise<unknown> =>
    Promise.resolve(withRepoLocks([...new Set(targets.map((t) => t.repo.name))], async () => h(targets)));

  // ---- Add (task 11) ----
  registerSvnCommand(
    context,
    services,
    'svnWorkflow.add',
    guarded(async (targets) => {
      const todo: SvnTarget[] = [];
      let skipped = 0;
      for (const t of targets) {
        const known = t.item ? t.item.item === 'unversioned' : await isUnversioned(ctxFor(t.repo), t.fsPath).catch((e: unknown) => e instanceof SvnError && e.kind === 'notWorkingCopy');
        if (known) todo.push(t);
        else skipped++;
      }
      if (!todo.length) {
        void vscode.window.showWarningMessage('SVN: nothing to add. The selection is already under version control (or ignored).');
        return;
      }
      let depth: AddDepth = 'infinity';
      if (todo.some((t) => isDir(t.fsPath))) {
        const pick = await vscode.window.showQuickPick(
          [
            { label: 'Everything inside', description: 'recursive (default)', depth: 'infinity' as AddDepth },
            { label: 'Files only', description: 'files directly in the folder', depth: 'files' as AddDepth },
            { label: 'Immediate children', description: 'files and sub-folders, but not their contents', depth: 'immediates' as AddDepth },
            { label: 'Folder only', description: 'the folder itself, no contents', depth: 'empty' as AddDepth },
          ],
          { placeHolder: 'How much of the selected folder(s) should be added?' },
        );
        if (!pick) return;
        depth = pick.depth;
      }
      await runOperation('Adding to version control', async (signal) => {
        for (const g of groupPathsByRepo(todo).values()) await addPaths(ctxFor(g.repo, signal), g.paths, depth);
      });
      const n = groupPathsByRepo(todo).size ? [...groupPathsByRepo(todo).values()].reduce((a, g) => a + g.paths.length, 0) : 0;
      notifySuccess(services, `Added ${n} item${n === 1 ? '' : 's'} to version control${skipped ? ` (${skipped} already versioned, skipped)` : ''}. Commit to share.`);
    }),
    { refreshAfter: true },
  );

  // ---- Ignore / un-ignore (task 12) ----
  registerSvnCommand(
    context,
    services,
    'svnWorkflow.ignore',
    guarded(async (targets) => {
      const versioned: SvnTarget[] = [];
      for (const t of targets) {
        const isVersioned = t.item ? t.item.item !== 'unversioned' : await services.client.info(t.fsPath, { repoName: t.repo.name }).then(() => true, () => false);
        if (isVersioned) versioned.push(t);
      }
      const names = targets.map((t) => path.basename(t.fsPath));
      const exts = [...new Set(targets.filter((t) => !isDir(t.fsPath)).map((t) => extensionPattern(path.basename(t.fsPath))).filter((p): p is string => !!p))];
      const options: { label: string; description: string; mode: 'name' | 'ext' | 'custom' }[] = [{ label: 'By name', description: names.slice(0, 4).join(', '), mode: 'name' }];
      if (exts.length) options.push({ label: 'By extension', description: exts.join(', '), mode: 'ext' });
      if (targets.length === 1) options.push({ label: 'Custom pattern...', description: 'e.g. *.log or build*', mode: 'custom' });
      const pick = options.length === 1 ? options[0] : await vscode.window.showQuickPick(options, { placeHolder: 'Add to svn:ignore of the parent folder' });
      if (!pick) return;
      let custom: string | undefined;
      if (pick.mode === 'custom') {
        custom = await vscode.window.showInputBox({ prompt: 'svn:ignore pattern (glob) for the parent folder', value: names[0], validateInput: (v) => (v.trim() && !/[\r\n/\\]$/.test(v) ? undefined : 'Enter a single glob pattern') });
        if (!custom) return;
        custom = custom.trim();
      }

      if (versioned.length) {
        const ok = await vscode.window.showWarningMessage(
          `${versioned.length} selected item${versioned.length === 1 ? ' is' : 's are'} under version control, and svn:ignore only affects unversioned items.`,
          { modal: true, detail: `Remove from version control (svn delete --keep-local; files stay on disk, commit the deletion to finish) and then ignore?\n\n${summarizePaths(versioned.map((t) => t.fsPath), (p) => rel(versioned[0].repo, p))}` },
          'Delete from SVN and Ignore',
        );
        if (!ok) return;
      }
      const dirs = new Map<string, { repo: RepoEntry; patterns: string[] }>();
      for (const t of targets) {
        const base = path.basename(t.fsPath);
        const pattern = pick.mode === 'custom' ? (custom as string) : pick.mode === 'ext' ? extensionPattern(base) ?? escapeGlob(base) : escapeGlob(base);
        const dir = path.dirname(t.fsPath);
        const g = dirs.get(dir) ?? { repo: t.repo, patterns: [] };
        g.patterns.push(pattern);
        dirs.set(dir, g);
      }
      const result = await runOperation('Updating svn:ignore', async (signal) => {
        for (const t of versioned) await deleteKeepLocal(ctxFor(t.repo, signal), t.fsPath);
        const out: { dir: string; repo: RepoEntry; added: string[]; present: string[] }[] = [];
        for (const [dir, g] of dirs) {
          const m = await addIgnore(ctxFor(g.repo, signal), dir, g.patterns);
          out.push({ dir, repo: g.repo, added: m.added, present: m.alreadyPresent });
        }
        return out;
      });
      const added = result.flatMap((r) => r.added);
      const where = result.map((r) => rel(r.repo, r.dir)).join(', ');
      if (added.length) notifySuccess(services, `Added ${added.join(', ')} to svn:ignore of ${where}. Commit the folder's property change to share it.`);
      else notifySuccess(services, 'Already in svn:ignore; nothing changed.');
    }),
    { refreshAfter: true },
  );

  registerSvnCommand(
    context,
    services,
    'svnWorkflow.unignore',
    guarded(async (targets) => {
      const t = targets[0];
      const dir = path.dirname(t.fsPath);
      const name = path.basename(t.fsPath);
      const entries = await readIgnore(ctxFor(t.repo), dir);
      if (!entries.length) {
        void vscode.window.showWarningMessage(`SVN: "${rel(t.repo, dir)}" has no svn:ignore entries.`);
        return;
      }
      const picks = await vscode.window.showQuickPick(
        entries.map((e) => ({ label: e, picked: globMatches(e, name), description: globMatches(e, name) ? `matches ${name}` : '' })),
        { canPickMany: true, placeHolder: `svn:ignore entries of ${rel(t.repo, dir)}: select the ones to remove` },
      );
      if (!picks?.length) return;
      await runOperation('Updating svn:ignore', (signal) => removeIgnorePatterns(ctxFor(t.repo, signal), dir, picks.map((p) => p.label)));
      notifySuccess(services, `Removed ${picks.map((p) => p.label).join(', ')} from svn:ignore of ${rel(t.repo, dir)}.`);
    }),
    { refreshAfter: true },
  );

  // ---- Override and Update (task 13) ----
  const overrideUpdateTargets = async (targets: SvnTarget[]): Promise<void> => {
    const groups = [...groupPathsByRepo(targets).values()];
    // Fresh server check once per repo, then guard every path against that state.
    for (const g of groups) {
      await requireIncoming(services, g.paths[0]);
      for (const p of g.paths.slice(1)) await requireIncoming(services, p, { refresh: false });
    }
    const lines: string[] = [];
    let unversioned = 0;
    let discardCount = 0;
    for (const g of groups) {
      const mine = services.incoming.getState(g.repo.name)?.items ?? [];
      const under = (i: { path: string }): boolean => g.paths.some((p) => isSameOrUnder(i.path, p));
      const local = mine.filter((i) => i.outgoing && i.item !== 'unversioned' && under(i));
      const unv = mine.filter((i) => i.item === 'unversioned' && under(i));
      const inc = mine.filter((i) => i.incoming && under(i));
      unversioned += unv.length;
      discardCount += local.length;
      lines.push(`Repository "${g.repo.name}": ${g.paths.map((p) => rel(g.repo, p)).join(', ')}`);
      lines.push(`LOCAL CHANGES THAT WILL BE DISCARDED (${local.length}):`);
      lines.push(local.length ? summarizePaths(local.map((i) => i.path), (p) => `${rel(g.repo, p)}  [${local.find((i) => i.path === p)?.item}]`) : '  none');
      lines.push(`Incoming changes that will be applied (${inc.length}):`);
      lines.push(summarizePaths(inc.map((i) => i.path), (p) => rel(g.repo, p), 8));
      if (unv.length) lines.push(`Unversioned files (${unv.length}) are KEPT unless you choose to delete them below.`);
      lines.push('');
    }
    lines.push('Locally added files become unversioned (kept on disk). This cannot be undone.');
    const main = 'Override and Update';
    const withDelete = 'Override, Update and DELETE Unversioned Files';
    const pick = await vscode.window.showWarningMessage(
      `Override and Update: discard ${discardCount} local change${discardCount === 1 ? '' : 's'} and update to the server version?`,
      { modal: true, detail: lines.join('\n') },
      main,
      ...(unversioned ? [withDelete] : []),
    );
    if (!pick) return;
    const removeUnversioned = pick === withDelete;
    const results = await withRepoLocks(groups.map((g) => g.repo.name), () => runOperation('Override and Update', async (signal, step) => {
      const out: { repo: RepoEntry; revision?: number; conflicts: string[] }[] = [];
      for (const g of groups) {
        step(g.repo.name);
        const r = await overrideUpdate(ctxFor(g.repo, signal), g.paths, { removeUnversioned, onStep: (m) => step(`${g.repo.name}: ${m}`) });
        out.push({ repo: g.repo, ...r });
      }
      return out;
    }).finally(async () => {
      for (const g of groups) await services.incoming.refresh({ repoName: g.repo.name, remote: true });
    }));
    if (!results) return;
    const conflicts = results.flatMap((r) => r.conflicts);
    const rev = results.map((r) => (r.revision ? `${r.repo.name} r${r.revision}` : r.repo.name)).join(', ');
    if (conflicts.length) await notifyConflicts(services, `Override and Update finished (${rev}) with conflicts: ${conflicts.join(', ')}`);
    else notifySuccess(services, `Override and Update done: ${rev}.`);
  };

  registerSvnCommand(context, services, 'svnWorkflow.overrideUpdate', overrideUpdateTargets);

  const pickRepo = async (placeHolder: string, only?: (r: RepoEntry) => boolean): Promise<RepoEntry | undefined> => {
    const list = services.repos.list().filter((r) => !only || only(r));
    if (!list.length) throw new Error('No matching repository is configured.');
    if (list.length === 1) return list[0];
    return (await vscode.window.showQuickPick(list.map((r) => ({ label: r.name, description: r.localFolder, repo: r })), { placeHolder }))?.repo;
  };

  // Title action: whole working copy of a chosen repo.
  context.subscriptions.push(
    vscode.commands.registerCommand('svnWorkflow.pane.overrideUpdateRepo', async () => {
      try {
        const repo = await pickRepo('Override and Update which repository (whole working copy)?', (r) => services.incoming.hasIncoming(r.localFolder));
        if (repo) await overrideUpdateTargets([{ repo, fsPath: repo.localFolder }]);
      } catch (e) {
        await reportError(services, e);
      }
    }),
  );

  // ---- Plain Update ----
  const updateTargets = async (targets: SvnTarget[]): Promise<void> => {
    for (const t of targets.filter((x) => x.wholeRepo)) {
      const count = services.incoming.getState(t.repo.name)?.items.filter((i) => i.incoming).length ?? 0;
      if (!(await confirmBulk('update', t.repo.name, t.fsPath, count))) return;
    }
    const ignoreList = services.localIgnore.paths();
    const groups = [...groupPathsByRepo(targets).values()].map((g) => ({ ...g, paths: expandUpdatePaths(g.paths, services.incoming.getState(g.repo.name)?.items ?? [], ignoreList) })).filter((g) => g.paths.length);
    if (!groups.length) {
      void vscode.window.showInformationMessage('SVN: nothing to update (the only incoming changes are on the Local Ignore List).');
      return;
    }
    const results = await withRepoLocks(groups.map((g) => g.repo.name), () => runOperation('Updating', async (signal, step) => {
      const out: { repo: RepoEntry; revision?: number; conflicts: string[] }[] = [];
      for (const g of groups) {
        step(g.repo.name);
        out.push({ repo: g.repo, ...(await updatePaths(ctxFor(g.repo, signal), g.paths)) });
      }
      return out;
    }).finally(async () => {
      for (const g of groups) await services.incoming.refresh({ repoName: g.repo.name, remote: true });
    }));
    if (!results) return;
    const conflicts = results.flatMap((r) => r.conflicts);
    const rev = results.map((r) => (r.revision ? `${r.repo.name} r${r.revision}` : r.repo.name)).join(', ');
    if (conflicts.length) await notifyConflicts(services, `Updated (${rev}) with conflicts: ${conflicts.join(', ')}. Resolve them before committing.`);
    else notifySuccess(services, `Updated ${rev}.`);
  };
  registerSvnCommand(context, services, 'svnWorkflow.update', updateTargets);
  context.subscriptions.push(
    vscode.commands.registerCommand('svnWorkflow.pane.updateAll', async () => {
      try {
        const repos = services.incoming.visibleRepos();
        if (!repos.length) throw new Error('The opened folder is not inside a registered working copy.');
        await updateTargets(repos.map((repo) => ({ repo, fsPath: services.incoming.scopeOf(repo)[0] ?? repo.localFolder, wholeRepo: true })));
      } catch (e) {
        await reportError(services, e);
      }
    }),
  );

  // ---- Commit dialog (task 35): the webview replaces the old single-line input box; it takes the per-repo lock itself while committing ----
  const commitFeature = createCommitFeature(context, services);
  registerSvnCommand(context, services, 'svnWorkflow.commit', (targets) => commitFeature.commit(targets));
  context.subscriptions.push(
    vscode.commands.registerCommand('svnWorkflow.pane.commitAll', async () => {
      try {
        await commitFeature.commitAll();
      } catch (e) {
        await reportError(services, e);
      }
    }),
  );
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { collectTargets, registerSvnCommand, type SvnTarget } from '../pane/commands';
import { groupPathsByRepo } from '../ops/targets';
import { RepoEntry } from '../repos/model';
import { Services } from '../services';
import { notifySuccess, runOperation } from '../util/notify';
import { reportError } from '../util/ui';
import { withRepoLockStrict } from '../util/repoCommand';
import { validateChangelistName } from './model';
import { addToChangelist, clearChangelist, listChangelists, removeFromChangelist, renameChangelist } from './ops';

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** What the commit dialog needs to start a changelist commit. */
export type CommitChangelistFn = (repo: RepoEntry, changelist: string) => Promise<void>;

export function registerChangelists(context: vscode.ExtensionContext, services: Services, commitChangelist: CommitChangelistFn): void {
  const ctxFor = (repo: RepoEntry, signal?: AbortSignal) => ({ client: services.client, repo, signal });

  /** Like registerSvnCommand but usable from the palette with nothing selected (targets may be empty). */
  const registerOptional = (id: string, handler: (targets: SvnTarget[]) => Promise<void>, refreshAfter = false): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (arg?: unknown, selection?: unknown) => {
        let targets: SvnTarget[] = [];
        try {
          targets = collectTargets(services, arg, selection);
        } catch {
          /* palette without a selection */
        }
        try {
          await handler(targets);
        } catch (e) {
          await reportError(services, e, targets[0]?.repo.name);
        } finally {
          if (refreshAfter) for (const n of new Set(targets.map((t) => t.repo.name))) services.incoming.requestRefresh({ repoName: n, remote: true });
        }
      }),
    );
  };

  const pickRepo = async (): Promise<RepoEntry | undefined> => {
    const list = services.repos.list();
    if (!list.length) throw new Error('No repository is configured.');
    if (list.length === 1) return list[0];
    return (await vscode.window.showQuickPick(list.map((r) => ({ label: r.name, description: r.localFolder, repo: r })), { placeHolder: 'Which repository?' }))?.repo;
  };

  /** The changelist of the clicked pane item/group, else a quick pick of the repo's changelists. */
  const chooseChangelist = async (targets: SvnTarget[], placeHolder: string): Promise<{ repo: RepoEntry; name: string } | undefined> => {
    const fromItem = targets.find((t) => t.item?.changelist);
    if (fromItem?.item?.changelist) return { repo: fromItem.repo, name: fromItem.item.changelist };
    const repo = targets[0]?.repo ?? (await pickRepo());
    if (!repo) return undefined;
    const lists = await listChangelists(ctxFor(repo));
    if (!lists.size) {
      void vscode.window.showInformationMessage(`SVN: "${repo.name}" has no changelists.`);
      return undefined;
    }
    const pick = await vscode.window.showQuickPick([...lists].map(([name, files]) => ({ label: name, description: `${files.length} file${files.length === 1 ? '' : 's'}` })), { placeHolder });
    return pick ? { repo, name: pick.label } : undefined;
  };

  const askNewName = (prompt: string, value?: string): Thenable<string | undefined> =>
    vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true, validateInput: (v) => validateChangelistName(v) });

  /** Existing changelist or a new name. */
  const nameForAdd = async (repo: RepoEntry): Promise<string | undefined> => {
    const lists = await listChangelists(ctxFor(repo));
    const NEW = '$(add) New changelist...';
    const pick = await vscode.window.showQuickPick([NEW, ...[...lists.keys()]], { placeHolder: 'Add to which changelist?' });
    if (!pick) return undefined;
    return pick === NEW ? (await askNewName('Name of the new changelist'))?.trim() : pick;
  };

  const versionedFiles = (targets: SvnTarget[]): SvnTarget[] => {
    const files = targets.filter((t) => !isDir(t.fsPath) && t.item?.item !== 'unversioned');
    if (!files.length) void vscode.window.showWarningMessage('SVN: changelists hold versioned files. Select one or more files (folders and unversioned files cannot join a changelist).');
    return files;
  };

  registerSvnCommand(
    context,
    services,
    'svnWorkflow.changelist.add',
    async (targets) => {
      const files = versionedFiles(targets);
      if (!files.length) return;
      const name = await nameForAdd(files[0].repo);
      if (!name) return;
      for (const g of groupPathsByRepo(files).values()) await withRepoLockStrict(g.repo.name, () => runOperation('Updating changelist', (signal) => addToChangelist(ctxFor(g.repo, signal), name, g.paths)));
      notifySuccess(services, `Added ${files.length} file${files.length === 1 ? '' : 's'} to changelist "${name}".`);
    },
    { refreshAfter: true },
  );

  registerSvnCommand(
    context,
    services,
    'svnWorkflow.changelist.remove',
    async (targets) => {
      const files = targets.filter((t) => !isDir(t.fsPath));
      if (!files.length) {
        void vscode.window.showWarningMessage('SVN: select the file(s) to remove from their changelist.');
        return;
      }
      for (const g of groupPathsByRepo(files).values()) await withRepoLockStrict(g.repo.name, () => runOperation('Updating changelist', (signal) => removeFromChangelist(ctxFor(g.repo, signal), g.paths)));
      notifySuccess(services, `Removed ${files.length} file${files.length === 1 ? '' : 's'} from their changelist.`);
    },
    { refreshAfter: true },
  );

  registerOptional(
    'svnWorkflow.changelist.create',
    async (targets) => {
      const repo = targets[0]?.repo ?? (await pickRepo());
      if (!repo) return;
      const name = (await askNewName('Name of the new changelist'))?.trim();
      if (!name) return;
      let paths = versionedFiles(targets.filter((t) => t.item || !isDir(t.fsPath))).map((t) => t.fsPath);
      if (!paths.length) {
        // No selection (palette): choose from the repo's modified files.
        const items = (services.incoming.getState(repo.name)?.items ?? []).filter((i) => i.outgoing && i.item !== 'unversioned' && !isDir(i.path));
        const picks = await vscode.window.showQuickPick(
          items.map((i) => ({ label: path.relative(repo.localFolder, i.path).split(path.sep).join('/'), description: i.item, path: i.path })),
          { canPickMany: true, placeHolder: `Files for the new changelist "${name}"` },
        );
        if (!picks?.length) return;
        paths = picks.map((p) => p.path);
      }
      await withRepoLockStrict(repo.name, () => runOperation('Creating changelist', (signal) => addToChangelist(ctxFor(repo, signal), name, paths)));
      notifySuccess(services, `Created changelist "${name}" with ${paths.length} file${paths.length === 1 ? '' : 's'}.`);
    },
    true,
  );

  registerOptional(
    'svnWorkflow.changelist.rename',
    async (targets) => {
      const c = await chooseChangelist(targets, 'Rename which changelist?');
      if (!c) return;
      const to = (await askNewName(`New name for changelist "${c.name}"`, c.name))?.trim();
      if (!to || to === c.name) return;
      const n = await withRepoLockStrict(c.repo.name, () => runOperation('Renaming changelist', (signal) => renameChangelist(ctxFor(c.repo, signal), c.name, to)));
      notifySuccess(services, `Renamed changelist "${c.name}" to "${to}" (${n} file${n === 1 ? '' : 's'}).`);
    },
    true,
  );

  registerOptional(
    'svnWorkflow.changelist.clear',
    async (targets) => {
      const c = await chooseChangelist(targets, 'Clear which changelist?');
      if (!c) return;
      const pick = await vscode.window.showWarningMessage(`Clear changelist "${c.name}"? Its files stay modified and are listed under Changes again.`, { modal: true }, 'Clear');
      if (pick !== 'Clear') return;
      const n = await withRepoLockStrict(c.repo.name, () => runOperation('Clearing changelist', (signal) => clearChangelist(ctxFor(c.repo, signal), c.name)));
      notifySuccess(services, `Cleared changelist "${c.name}" (${n} file${n === 1 ? '' : 's'}).`);
    },
    true,
  );

  registerOptional('svnWorkflow.changelist.commit', async (targets) => {
    const c = await chooseChangelist(targets, 'Commit which changelist?');
    if (c) await commitChangelist(c.repo, c.name);
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('svnWorkflow.changelist.list', async () => {
      try {
        const repo = await pickRepo();
        if (!repo) return;
        const lists = await listChangelists(ctxFor(repo));
        if (!lists.size) {
          void vscode.window.showInformationMessage(`SVN: "${repo.name}" has no changelists.`);
          return;
        }
        await vscode.window.showQuickPick([...lists].map(([name, files]) => ({ label: name, description: `${files.length} file(s)`, detail: files.join(', ') })), { placeHolder: `Changelists in ${repo.name}` });
      } catch (e) {
        await reportError(services, e);
      }
    }),
  );
}

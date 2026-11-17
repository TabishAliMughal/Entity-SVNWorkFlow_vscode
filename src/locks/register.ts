import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { registerSvnCommand, type SvnTarget } from '../pane/commands';
import { groupPathsByRepo } from '../ops/targets';
import { CONFIG_SECTION, Services } from '../services';
import { SvnError } from '../svn/errors';
import { notifySuccess, runOperation } from '../util/notify';
import { reportError } from '../util/ui';
import { lockCache } from './cache';
import { describeLock, lockBadge, needsLockPrompt, type LockView } from './model';
import { hasNeedsLock, isReadOnlyOnDisk, listLocks, lockOf, lockPaths, unlockPaths } from './ops';
import { tmpDirOf, withRepoLockStrict } from '../util/repoCommand';

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const heldByOther = (e: unknown): boolean => e instanceof Error && /E160035|E200035|already locked|locked by/i.test(`${e.message} ${(e as SvnError).stderr ?? ''}`);
const rel = (root: string, p: string): string => path.relative(root, p).split(path.sep).join('/') || path.basename(p);

export function registerLocks(context: vscode.ExtensionContext, services: Services): void {
  services.incoming.onEntries = (repo, entries, remote) => lockCache.update(repo.name, repo.localFolder, entries, remote);
  context.subscriptions.push({ dispose: () => (services.incoming.onEntries = undefined) });
  const ctxFor = (target: { repo: SvnTarget['repo'] }, signal?: AbortSignal) => ({ client: services.client, repo: target.repo, signal });

  /** Files only: svn cannot lock folders. */
  const filesOf = (targets: SvnTarget[]): SvnTarget[] => {
    const files = targets.filter((t) => !isDir(t.fsPath));
    if (!files.length) void vscode.window.showWarningMessage('SVN: locks apply to files. Select one or more files.');
    else if (files.length < targets.length) void vscode.window.showInformationMessage(`SVN: ${targets.length - files.length} folder(s) skipped (only files can be locked).`);
    return files;
  };

  const lockFiles = async (targets: SvnTarget[], opts: { force: boolean; comment?: string }): Promise<void> => {
    const files = filesOf(targets);
    if (!files.length) return;
    let comment = opts.comment;
    if (comment === undefined) {
      comment = await vscode.window.showInputBox({ title: `${opts.force ? 'Steal lock' : 'Lock'}: ${files.length === 1 ? path.basename(files[0].fsPath) : `${files.length} files`}`, prompt: 'Lock comment (optional)', ignoreFocusOut: true });
      if (comment === undefined) return;
    }
    const groups = [...groupPathsByRepo(files).values()];
    for (const g of groups) {
      try {
        await withRepoLockStrict(g.repo.name, () => runOperation(opts.force ? 'Stealing lock' : 'Locking', (signal) => lockPaths({ ...ctxFor(g, signal), tmpDir: tmpDirOf(context) }, g.paths, comment.trim(), opts.force)));
      } catch (e) {
        if (!opts.force && heldByOther(e)) {
          const pick = await vscode.window.showWarningMessage(`SVN: a file is locked by someone else.\n${(e as Error).message}`, 'Steal Lock...');
          if (pick) await stealLocks(files.filter((f) => f.repo.name === g.repo.name));
          continue;
        }
        throw e;
      }
      notifySuccess(services, `Locked ${g.paths.map((p) => rel(g.repo.localFolder, p)).join(', ')}.`);
    }
  };

  const lockSummary = async (t: SvnTarget): Promise<string> => describeLock(await lockOf(ctxFor(t), t.fsPath));

  const stealLocks = async (targets: SvnTarget[]): Promise<void> => {
    const files = filesOf(targets);
    if (!files.length) return;
    const lines: string[] = [];
    for (const f of files.slice(0, 10)) lines.push(`${rel(f.repo.localFolder, f.fsPath)}: ${await lockSummary(f)}`);
    const pick = await vscode.window.showWarningMessage(
      `Steal the lock on ${files.length} file${files.length === 1 ? '' : 's'}?`,
      { modal: true, detail: `${lines.join('\n')}\n\nThe current owner loses the lock and their next commit of the file may fail until they update. You will hold the lock.` },
      'Steal Lock',
    );
    if (pick === 'Steal Lock') await lockFiles(files, { force: true, comment: 'Lock stolen' });
  };

  const breakLocks = async (targets: SvnTarget[]): Promise<void> => {
    const files = filesOf(targets);
    if (!files.length) return;
    const lines: string[] = [];
    for (const f of files.slice(0, 10)) lines.push(`${rel(f.repo.localFolder, f.fsPath)}: ${await lockSummary(f)}`);
    const pick = await vscode.window.showWarningMessage(
      `Break the lock on ${files.length} file${files.length === 1 ? '' : 's'}?`,
      { modal: true, detail: `${lines.join('\n')}\n\nThe lock is removed on the server without taking it over. The owner may lose unsaved lock-protected work.` },
      'Break Lock',
    );
    if (pick !== 'Break Lock') return;
    for (const g of groupPathsByRepo(files).values()) {
      await withRepoLockStrict(g.repo.name, () => runOperation('Breaking lock', (signal) => unlockPaths(ctxFor(g, signal), g.paths, true)));
      notifySuccess(services, `Broke the lock on ${g.paths.map((p) => rel(g.repo.localFolder, p)).join(', ')}.`);
    }
  };

  registerSvnCommand(context, services, 'svnWorkflow.lock', (targets) => lockFiles(targets, { force: false }), { refreshAfter: true });
  registerSvnCommand(context, services, 'svnWorkflow.lock.steal', stealLocks, { refreshAfter: true });
  registerSvnCommand(context, services, 'svnWorkflow.lock.break', breakLocks, { refreshAfter: true });

  registerSvnCommand(
    context,
    services,
    'svnWorkflow.unlock',
    async (targets) => {
      const files = filesOf(targets);
      for (const g of groupPathsByRepo(files).values()) {
        try {
          await withRepoLockStrict(g.repo.name, () => runOperation('Unlocking', (signal) => unlockPaths(ctxFor(g, signal), g.paths)));
          notifySuccess(services, `Unlocked ${g.paths.map((p) => rel(g.repo.localFolder, p)).join(', ')}.`);
        } catch (e) {
          if (!(e instanceof Error) || !/E160040|E200035|E195013|not locked|locked by|no lock|owner/i.test(`${e.message} ${(e as SvnError).stderr ?? ''}`)) throw e;
          const pick = await vscode.window.showWarningMessage(`SVN: could not unlock normally (${e.message.split('\n')[0]}).`, 'Break Lock...');
          if (pick) await breakLocks(files.filter((f) => f.repo.name === g.repo.name));
        }
      }
    },
    { refreshAfter: true },
  );

  registerSvnCommand(context, services, 'svnWorkflow.lock.info', async (targets) => {
    const t = filesOf(targets)[0];
    if (!t) return;
    const v = await runOperation('Reading lock info', (signal) => lockOf(ctxFor(t, signal), t.fsPath));
    const i = v.info;
    const lines = [describeLock(v)];
    if (i?.owner) lines.push(`Owner: ${i.owner}`);
    if (i?.created) lines.push(`Locked: ${new Date(i.created).toLocaleString()}`);
    if (i?.comment) lines.push(`Comment: ${i.comment}`);
    void vscode.window.showInformationMessage(`SVN lock: ${path.basename(t.fsPath)}`, { modal: true, detail: lines.join('\n') });
  });

  // Palette/pane title: every lock of a repo, pick one to act on.
  context.subscriptions.push(
    vscode.commands.registerCommand('svnWorkflow.lock.list', async () => {
      try {
        const repos = services.repos.list();
        if (!repos.length) throw new Error('No repository is configured.');
        const repo =
          repos.length === 1 ? repos[0] : (await vscode.window.showQuickPick(repos.map((r) => ({ label: r.name, repo: r })), { placeHolder: 'List locks of which repository?' }))?.repo;
        if (!repo) return;
        const locks = await runOperation('Listing locks', (signal) => listLocks(ctxFor({ repo }, signal)));
        if (!locks.length) {
          void vscode.window.showInformationMessage(`SVN: no locks in "${repo.name}".`);
          return;
        }
        const pick = await vscode.window.showQuickPick(
          locks.map((l) => ({ label: `$(lock) ${l.path}`, description: describeLock(l.view), l })),
          { placeHolder: `${locks.length} lock(s) in ${repo.name}: pick one to open` },
        );
        if (pick) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.resolve(repo.localFolder, pick.l.path)));
      } catch (e) {
        await reportError(services, e);
      }
    }),
  );

  // ---- decorations and hover ----
  const decoChanged = new vscode.EventEmitter<undefined>();
  context.subscriptions.push(
    decoChanged,
    lockCache.onDidChange(() => decoChanged.fire(undefined)),
    vscode.window.registerFileDecorationProvider({
      onDidChangeFileDecorations: decoChanged.event as vscode.Event<vscode.Uri[] | undefined>,
      provideFileDecoration: (uri) => {
        if (uri.scheme !== 'file') return undefined;
        const v = lockCache.find(uri.fsPath);
        const badge = lockBadge(v);
        return badge ? new vscode.FileDecoration(badge, describeLock(v), new vscode.ThemeColor(v.state === 'mine' ? 'gitDecoration.addedResourceForeground' : 'list.warningForeground')) : undefined;
      },
    }),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, {
      provideHover: (doc, pos) => {
        if (pos.line !== 0) return undefined;
        const repo = services.resolver.resolve(doc.uri.fsPath);
        if (!repo) return undefined;
        const v = lockCache.get(repo.name, doc.uri.fsPath);
        if (v.state === 'none') return undefined;
        const md = new vscode.MarkdownString(undefined, true);
        md.appendMarkdown(`$(lock) **SVN lock**\n\n${describeLock(v)}`);
        return new vscode.Hover(md);
      },
    }),
  );

  // ---- svn:needs-lock awareness ----
  const prompted = new Set<string>();
  const checkNeedsLock = async (doc: vscode.TextDocument): Promise<void> => {
    if (doc.uri.scheme !== 'file') return;
    if (!vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('locks.promptNeedsLock', true)) return;
    const p = doc.uri.fsPath;
    const key = p.toLowerCase();
    if (prompted.has(key)) return;
    const repo = services.resolver.resolve(p);
    if (!repo || !isReadOnlyOnDisk(p)) return;
    const needsLock = await hasNeedsLock(ctxFor({ repo }), p).catch(() => false);
    const view: LockView = lockCache.get(repo.name, p);
    if (!needsLockPrompt({ needsLock, readOnly: true, state: view.state })) return;
    prompted.add(key);
    const pick = await vscode.window.showInformationMessage(`SVN: "${path.basename(p)}" needs a lock (svn:needs-lock) and is read-only until you lock it.`, 'Lock to Edit');
    if (pick === 'Lock to Edit') {
      try {
        await vscode.commands.executeCommand('svnWorkflow.lock', doc.uri);
        prompted.delete(key);
        // Make the open editor writable now that svn removed the read-only flag.
        if (vscode.window.activeTextEditor?.document === doc) await vscode.commands.executeCommand('workbench.action.files.setActiveEditorWriteableInSession');
      } catch {
        /* the lock command already reported the error */
      }
    }
  };
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((d) => void checkNeedsLock(d)),
    vscode.window.onDidChangeActiveTextEditor((e) => e && void checkNeedsLock(e.document)),
  );
  for (const e of vscode.window.visibleTextEditors) void checkNeedsLock(e.document);
}

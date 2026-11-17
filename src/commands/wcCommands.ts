import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { normalizePath } from '../repos/resolver';
import { RepoEntry, checkServerUrl } from '../repos/model';
import { groupPathsByRepo, summarizePaths } from '../ops/targets';
import { SvnTarget, collectTargets, registerSvnCommand } from '../pane/commands';
import { Services, CONFIG_SECTION } from '../services';
import { Credentials } from '../svn/client';
import { SvnError } from '../svn/errors';
import { notifySuccess, runOperation } from '../util/notify';
import { notifyConflicts } from '../conflict/notice';
import { reportError } from '../util/ui';
import { confirmCertificateTrust } from '../util/trustUi';
import { acquireRepoLocks } from '../wc/lock';
import { DEPTH_CHOICES, SetDepth, copyName, defaultFolderName, planRevert, rebaseUrl, resolveSvnUrl, parseRevisionInput, revertable, validateRelativeName } from '../wc/model';
import * as ops from '../wc/ops';
import { joinSvnUrl } from '../util/svnUrl';
import { WcCtx } from '../wc/ops';

const rel = (repo: RepoEntry, p: string): string => path.relative(repo.localFolder, p).split(path.sep).join('/') || `(${repo.name} root)`;
const isoDir = (p: string): boolean => ops.isDirSafe(p);

/** Runs `fn` while holding the per-repo lock of every named repo; warns and returns undefined if one is busy. */
export async function withRepoLocks<T>(names: readonly string[], fn: () => Promise<T>): Promise<T | undefined> {
  const l = acquireRepoLocks(names);
  if ('busy' in l) {
    void vscode.window.showWarningMessage(`SVN operation in progress on "${l.busy}". Wait for it to finish.`);
    return undefined;
  }
  try {
    return await fn();
  } finally {
    l.release();
  }
}

async function pickRepo(services: Services, placeHolder: string): Promise<RepoEntry | undefined> {
  const list = services.repos.list();
  if (!list.length) throw new Error('No SVN repository is configured. Add one or use Checkout first.');
  if (list.length === 1) return list[0];
  const active = vscode.window.activeTextEditor?.document.uri;
  const preferred = active?.scheme === 'file' ? services.resolver.resolve(active.fsPath) : undefined;
  const items = list.map((r) => ({ label: r.name, description: r.localFolder, repo: r, picked: r === preferred }));
  items.sort((a, b) => Number(b.repo.name === preferred?.name) - Number(a.repo.name === preferred?.name));
  return (await vscode.window.showQuickPick(items, { placeHolder }))?.repo;
}

type PaletteMode = 'repo' | 'active';

/**
 * Like registerSvnCommand, but invoked without arguments (palette, view title) a `repo` command asks for
 * a repository and works on its whole working copy instead of the active file.
 */
function registerWc(
  context: vscode.ExtensionContext,
  services: Services,
  id: string,
  handler: (targets: SvnTarget[]) => unknown | Promise<unknown>,
  opts: { palette: PaletteMode; refreshAfter?: boolean },
): void {
  if (opts.palette === 'active') {
    registerSvnCommand(context, services, id, handler, { refreshAfter: opts.refreshAfter });
    return;
  }
  context.subscriptions.push(
    vscode.commands.registerCommand(id, async (arg?: unknown, selection?: unknown) => {
      let names: string[] = [];
      try {
        let targets: SvnTarget[];
        if (arg === undefined || (typeof arg === 'string' && services.repos.find(arg))) {
          const repo = typeof arg === 'string' ? services.repos.find(arg) : await pickRepo(services, 'Which repository (whole working copy)?');
          if (!repo) return;
          targets = [{ repo, fsPath: repo.localFolder }];
        } else targets = collectTargets(services, arg, selection);
        names = [...new Set(targets.map((t) => t.repo.name))];
        await handler(targets);
      } catch (e) {
        await reportError(services, e, names[0]);
      } finally {
        if (opts.refreshAfter) for (const n of names) services.incoming.requestRefresh({ repoName: n, remote: true });
      }
    }),
  );
}

export function registerWcCommands(context: vscode.ExtensionContext, services: Services): void {
  const ctx = (repo: RepoEntry, signal?: AbortSignal): WcCtx => ({ client: services.client, repo, signal });
  const sub = (c: vscode.Disposable): number => context.subscriptions.push(c);

  // ---------- Task 30: checkout ----------
  sub(
    vscode.commands.registerCommand('svnWorkflow.checkout', async () => {
      try {
        await checkoutFlow(services);
      } catch (e) {
        await reportError(services, e);
      }
    }),
  );

  registerWc(context, services, 'svnWorkflow.relocate', async (targets) => {
    const repo = targets[0].repo;
    const before = await ops.wcInfo(ctx(repo));
    const input = await vscode.window.showInputBox({
      title: `Relocate "${repo.name}"`,
      prompt: 'New URL of the repository (same repository, e.g. after a server move or host/protocol change)',
      value: before.url,
      ignoreFocusOut: true,
      validateInput: (v) => checkServerUrl(resolveSvnUrl(v, before.repositoryRoot)).error,
    });
    if (input === undefined) return;
    const url = resolveSvnUrl(input, before.repositoryRoot);
    if (url.toLowerCase() === before.url.replace(/\/+$/, '').toLowerCase()) {
      void vscode.window.showInformationMessage('SVN: the working copy already points to that URL.');
      return;
    }
    let trust: boolean | undefined;
    for (;;) {
      try {
        await withRepoLocks([repo.name], () =>
          runOperation(`Relocating ${repo.name}`, (signal) => ops.relocate(ctx(repo, signal), url)),
        );
        break;
      } catch (e) {
        if (e instanceof SvnError && e.kind === 'certificate' && trust === undefined && /^https:/i.test(url)) {
          const c = await confirmCertificateTrust(url, 'The certificate is not trusted. Trust it and retry?');
          if (!c.trusted) return;
          trust = true;
          await services.repos.update(repo.name, { ...repo, trustServerCert: true, trustedCertFingerprint: c.fingerprint });
          repo.trustServerCert = true;
          repo.trustedCertFingerprint = c.fingerprint;
          services.certs.reset(repo.name);
          continue;
        }
        throw e;
      }
    }
    const next = rebaseUrl(repo.serverUrl, before.url, url);
    await services.repos.update(repo.name, { ...repo, serverUrl: next });
    notifySuccess(services, `Relocated "${repo.name}" to ${url}. The repository entry now points to ${next}.`);
  }, { palette: 'repo' });

  // ---------- Task 31: revert, cleanup, upgrade ----------
  registerWc(
    context,
    services,
    'svnWorkflow.revert',
    async (targets) => {
      for (const g of groupPathsByRepo(targets).values()) {
        const c = ctx(g.repo);
        const byPath = new Map<string, ops.WcStatusItem['entry']>();
        for (const p of g.paths) for (const e of revertable(await ops.statusEntries(c, p))) byPath.set(normalizePath(e.path), e);
        const cands = [...byPath.values()].map((e) => ({ path: e.path, item: e.item, props: e.props, isDir: isoDir(e.path) || e.item === 'missing' }));
        if (!cands.length) {
          void vscode.window.showInformationMessage(`SVN: nothing to revert in ${g.paths.map((p) => rel(g.repo, p)).join(', ')} (${g.repo.name}).`);
          continue;
        }
        const describe = (e: { item: string; props?: string }): string => (e.props && e.props !== 'none' && e.props !== 'normal' ? `${e.item}, props ${e.props}` : e.item);
        const picks = await vscode.window.showQuickPick(
          cands.map((x) => ({ label: rel(g.repo, x.path), description: describe(x), picked: true, cand: x })),
          { canPickMany: true, title: `Revert changes in ${g.repo.name}`, placeHolder: 'Select the items whose local changes should be discarded', matchOnDescription: true },
        );
        if (!picks?.length) continue;
        const ok = await vscode.window.showWarningMessage(
          `Revert ${picks.length} item${picks.length === 1 ? '' : 's'} in "${g.repo.name}"? Local changes are discarded and cannot be recovered.`,
          { modal: true, detail: `${summarizePaths(picks.map((p) => p.cand.path), (p) => `${rel(g.repo, p)}  [${cands.find((x) => x.path === p)?.item}]`)}\n\nAdded items stay on disk as unversioned files.` },
          'Revert',
        );
        if (!ok) continue;
        const plan = planRevert(cands, new Set(picks.map((p) => normalizePath(p.cand.path))));
        await withRepoLocks([g.repo.name], () => runOperation('Reverting', (signal) => ops.revertSteps(ctx(g.repo, signal), plan)));
        notifySuccess(services, `Reverted ${picks.length} item${picks.length === 1 ? '' : 's'} in ${g.repo.name}.`);
      }
    },
    { palette: 'repo', refreshAfter: true },
  );

  registerWc(
    context,
    services,
    'svnWorkflow.cleanup',
    async (targets) => {
      const repo = targets[0].repo;
      const paths = groupPathsByRepo(targets).get(repo.name)?.paths ?? [repo.localFolder];
      const opt = await vscode.window.showQuickPick(
        [
          { label: 'Clean up working copy', description: 'remove stale write locks, finish interrupted operations', key: 'locks', picked: true },
          { label: 'Break repository locks', description: 'svn unlock --force on locked files here (server contact)', key: 'unlock' },
          { label: 'Remove unversioned files...', description: 'preview, then delete', key: 'unversioned' },
          { label: 'Remove ignored files...', description: 'preview, then delete (build output etc.)', key: 'ignored' },
          { label: 'Vacuum pristine copies', description: 'free disk space in .svn', key: 'vacuum' },
          { label: 'Include externals', description: 'also process svn:externals folders', key: 'externals' },
        ],
        { canPickMany: true, title: `Cleanup ${repo.name}`, placeHolder: 'Choose what to do' },
      );
      if (!opt?.length) return;
      const has = (k: string): boolean => opt.some((o) => o.key === k);
      const c = ctx(repo);

      let junk: string[] = [];
      if (has('unversioned') || has('ignored')) {
        const found = await runOperation('Scanning for unversioned / ignored files', () => ops.junkUnder(c, paths, { unversioned: has('unversioned'), ignored: has('ignored') }));
        if (!found.length) void vscode.window.showInformationMessage('SVN: no unversioned / ignored files found.');
        else {
          const sel = await vscode.window.showQuickPick(
            found.map((e) => ({ label: rel(repo, e.path) + (isoDir(e.path) ? '/' : ''), description: e.item, picked: e.item === 'unversioned', e })),
            { canPickMany: true, title: 'Files to delete from disk', placeHolder: 'Preview: only ticked items are deleted' },
          );
          junk = sel?.map((s) => s.e.path) ?? [];
        }
      }
      let locked: string[] = [];
      if (has('unlock')) {
        locked = await runOperation('Looking for locks', (signal) => ops.breakRepoLocks(ctx(repo, signal), paths, true));
        if (!locked.length) void vscode.window.showInformationMessage('SVN: no locked files found here.');
      }
      const will = [
        junk.length ? `Delete ${junk.length} unversioned/ignored item(s) from disk (no undo)` : '',
        locked.length ? `Break ${locked.length} repository lock(s)` : '',
        has('locks') ? 'Clean up working copy' : '',
        has('vacuum') ? 'Vacuum pristine copies' : '',
      ].filter(Boolean);
      if (!will.length) return;
      if (junk.length || locked.length) {
        const ok = await vscode.window.showWarningMessage(`Run cleanup on "${repo.name}"?`, { modal: true, detail: `${will.join('\n')}\n\n${summarizePaths([...junk, ...locked], (p) => rel(repo, p), 10)}` }, 'Run Cleanup');
        if (!ok) return;
      }
      await withRepoLocks([repo.name], () =>
        runOperation('Cleanup', async (signal, step) => {
          const cc = ctx(repo, signal);
          if (locked.length) {
            step('Breaking locks');
            await ops.breakRepoLocks(cc, paths);
          }
          if (junk.length) {
            step('Removing files');
            await ops.removePaths(cc, junk);
          }
          if (has('locks') || has('vacuum') || has('externals')) {
            step('Cleaning up');
            await ops.cleanup(cc, paths, { vacuumPristines: has('vacuum'), includeExternals: has('externals') });
          }
        }),
      );
      notifySuccess(services, `Cleanup of ${repo.name} done: ${will.join('; ')}.`);
    },
    { palette: 'repo', refreshAfter: true },
  );

  registerWc(
    context,
    services,
    'svnWorkflow.upgradeWc',
    async (targets) => {
      const repo = targets[0].repo;
      const ok = await vscode.window.showWarningMessage(
        `Upgrade the working copy format of "${repo.name}"?`,
        { modal: true, detail: 'Only needed for working copies created by an older Subversion. Older clients (and older TortoiseSVN versions) can no longer use this working copy afterwards.' },
        'Upgrade',
      );
      if (!ok) return;
      await withRepoLocks([repo.name], () => runOperation('Upgrading working copy', (signal) => ops.upgradeWc(ctx(repo, signal), repo.localFolder)));
      notifySuccess(services, `Working copy of ${repo.name} upgraded.`);
    },
    { palette: 'repo' },
  );

  // ---------- Task 32: update to revision, switch, set-depth ----------
  registerWc(
    context,
    services,
    'svnWorkflow.updateToRevision',
    async (targets) => {
      const rev = await vscode.window.showInputBox({
        title: 'Update to Revision',
        prompt: `Revision for ${targets.length === 1 ? rel(targets[0].repo, targets[0].fsPath) : `${targets.length} items`}: a number, HEAD or {YYYY-MM-DD}`,
        value: 'HEAD',
        ignoreFocusOut: true,
        validateInput: (v) => {
          const r = parseRevisionInput(v);
          return r.ok ? undefined : r.error;
        },
      });
      if (rev === undefined) return;
      const parsed = parseRevisionInput(rev);
      if (!parsed.ok) return;
      const groups = [...groupPathsByRepo(targets).values()];
      const results = await withRepoLocks(groups.map((g) => g.repo.name), () =>
        runOperation(`Updating to ${parsed.rev}`, async (signal) => {
          const out: Array<{ repo: RepoEntry; r: ops.UpdateOutcome }> = [];
          for (const g of groups) out.push({ repo: g.repo, r: await ops.updateToRevision(ctx(g.repo, signal), g.paths, parsed.rev) });
          return out;
        }),
      );
      if (!results) return;
      const conflicts = results.flatMap((x) => x.r.conflicts);
      const text = results.map((x) => `${x.repo.name} r${x.r.revision ?? parsed.rev}`).join(', ');
      if (conflicts.length) await notifyConflicts(services, `Updated to ${text} with conflicts: ${conflicts.join(', ')}`);
      else notifySuccess(services, `Updated to ${text}.`);
    },
    { palette: 'repo', refreshAfter: true },
  );

  registerWc(
    context,
    services,
    'svnWorkflow.switch',
    async (targets) => {
      if (targets.length !== 1) {
        void vscode.window.showWarningMessage('SVN: switch works on one folder (usually the working copy root) at a time.');
        return;
      }
      const { repo, fsPath } = targets[0];
      const info = await ops.wcInfo(ctx(repo), fsPath);
      const root = info.repositoryRoot.replace(/\/+$/, '');
      const lists = await runOperation('Listing branches and tags', async (signal) => ({
        branches: await ops.listRepoFolder(ctx(repo, signal), root, 'branches'),
        tags: await ops.listRepoFolder(ctx(repo, signal), root, 'tags'),
        trunk: (await ops.listRepoFolder(ctx(repo, signal), root, '')).includes('trunk'),
      }));
      type Item = vscode.QuickPickItem & { url?: string; custom?: boolean };
      const items: Item[] = [];
      if (lists.trunk) items.push({ label: 'trunk', description: '^/trunk', url: joinSvnUrl(root, 'trunk') });
      if (lists.branches.length) items.push({ label: 'Branches', kind: vscode.QuickPickItemKind.Separator }, ...lists.branches.map((b) => ({ label: b, description: `^/branches/${b}`, url: joinSvnUrl(root, 'branches', b) })));
      if (lists.tags.length) items.push({ label: 'Tags', kind: vscode.QuickPickItemKind.Separator }, ...lists.tags.map((t) => ({ label: t, description: `^/tags/${t}`, url: joinSvnUrl(root, 'tags', t) })));
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: '$(link) Enter a URL...', custom: true });
      const pick = await vscode.window.showQuickPick(items, { title: `Switch ${rel(repo, fsPath)} (now ${info.url})`, placeHolder: lists.branches.length || lists.tags.length ? 'Pick a branch or tag' : 'No ^/branches or ^/tags found; enter a URL', matchOnDescription: true });
      if (!pick) return;
      let url = pick.url;
      if (pick.custom || !url) {
        const v = await vscode.window.showInputBox({ title: 'Switch to URL', prompt: 'Full URL or ^/path relative to the repository root', value: info.url, ignoreFocusOut: true, validateInput: (x) => checkServerUrl(resolveSvnUrl(x, root)).error });
        if (!v) return;
        url = resolveSvnUrl(v, root);
      }
      if (url.toLowerCase() === info.url.toLowerCase()) {
        void vscode.window.showInformationMessage('SVN: already on that URL.');
        return;
      }
      const result = await withRepoLocks([repo.name], () => runOperation(`Switching to ${url}`, (signal) => ops.switchTo(ctx(repo, signal), fsPath, url as string)));
      if (!result) return;
      if (normalizePath(fsPath) === normalizePath(repo.localFolder)) await services.repos.update(repo.name, { ...repo, serverUrl: rebaseUrl(repo.serverUrl, info.url, url) });
      if (result.conflicts.length) await notifyConflicts(services, `Switched to ${url} with conflicts: ${result.conflicts.join(', ')}`);
      else notifySuccess(services, `Switched ${rel(repo, fsPath)} to ${url} (r${result.revision ?? '?'}).`);
    },
    { palette: 'repo', refreshAfter: true },
  );

  registerWc(
    context,
    services,
    'svnWorkflow.setDepth',
    async (targets) => {
      const t = targets[0];
      const single = targets.length === 1;
      const pick = await vscode.window.showQuickPick(
        [
          ...DEPTH_CHOICES.map((d) => ({ label: d.label, description: `${d.description} (--set-depth ${d.depth})`, depth: d.depth as SetDepth | 'sparse' })),
          ...(single && isoDir(t.fsPath) ? [{ label: 'Choose children from the server...', description: 'sparse update: add selected sub-folders / files', depth: 'sparse' as const }] : []),
          { label: 'Exclude from working copy', description: 'remove from disk, keep versioned data on server (--set-depth exclude)', depth: 'exclude' as const },
        ],
        { title: `Set Depth: ${single ? rel(t.repo, t.fsPath) : `${targets.length} items`}`, placeHolder: 'Reduce depth removes content from disk; local modifications block removal' },
      );
      if (!pick) return;
      const c = ctx(t.repo);
      if (pick.depth === 'sparse') {
        const kids = await runOperation('Listing server content', () => ops.remoteChildren(c, t.fsPath));
        const sel = await vscode.window.showQuickPick(
          kids.map((k) => ({ label: k.name + (k.dir ? '/' : ''), description: k.present ? 'in working copy' : 'not checked out', picked: false, k })),
          { canPickMany: true, title: 'Add to working copy (full depth)' },
        );
        if (!sel?.length) return;
        await withRepoLocks([t.repo.name], () => runOperation('Sparse update', (signal) => ops.includeChildren(ctx(t.repo, signal), t.fsPath, sel.map((s) => s.k.name))));
        notifySuccess(services, `Added ${sel.map((s) => s.k.name).join(', ')} to the working copy.`);
        return;
      }
      const depth = pick.depth;
      if (depth === 'exclude' || depth === 'empty' || depth === 'files') {
        const ok = await vscode.window.showWarningMessage(`Set depth "${depth}" on ${single ? rel(t.repo, t.fsPath) : `${targets.length} items`}?`, { modal: true, detail: 'Content outside the new depth is removed from the working copy (not from the server). Unversioned or modified files may block the removal.' }, 'Set Depth');
        if (!ok) return;
      }
      const groups = [...groupPathsByRepo(targets).values()];
      await withRepoLocks(groups.map((g) => g.repo.name), () =>
        runOperation('Setting depth', async (signal) => {
          for (const g of groups) for (const p of g.paths) await ops.setDepth(ctx(g.repo, signal), p, depth);
        }),
      );
      notifySuccess(services, `Depth set to ${depth}.`);
    },
    { palette: 'repo', refreshAfter: true },
  );

  // ---------- Task 33: file operations ----------
  const versionedTargets = async (targets: SvnTarget[]): Promise<{ versioned: SvnTarget[]; unversioned: SvnTarget[] }> => {
    const versioned: SvnTarget[] = [];
    const unversioned: SvnTarget[] = [];
    for (const t of targets) {
      const isUnv = t.item ? t.item.item === 'unversioned' : await ops.isUnversionedPath(ctx(t.repo), t.fsPath);
      (isUnv ? unversioned : versioned).push(t);
    }
    return { versioned, unversioned };
  };
  const sameRepo = (repo: RepoEntry, p: string): boolean => services.resolver.resolve(p)?.name === repo.name;

  registerSvnCommand(
    context,
    services,
    'svnWorkflow.delete',
    async (targets) => {
      const { versioned, unversioned } = await versionedTargets(targets);
      const all = [...versioned, ...unversioned];
      const ok = await vscode.window.showWarningMessage(
        `Delete ${all.length} item${all.length === 1 ? '' : 's'}?`,
        {
          modal: true,
          detail: `${summarizePaths(all.map((t) => t.fsPath), (p) => rel(all[0].repo, p))}\n\n${versioned.length ? `${versioned.length} versioned item(s): scheduled for deletion with svn delete (removed from disk, local modifications lost; commit to finish).\n` : ''}${unversioned.length ? `${unversioned.length} unversioned item(s): moved to the Recycle Bin.` : ''}`,
        },
        'Delete',
      );
      if (!ok) return;
      for (const t of unversioned) await vscode.workspace.fs.delete(vscode.Uri.file(t.fsPath), { recursive: true, useTrash: true });
      for (const g of groupPathsByRepo(versioned).values()) await withRepoLocks([g.repo.name], () => runOperation('Deleting', (signal) => ops.deletePaths(ctx(g.repo, signal), g.paths)));
      notifySuccess(services, `Deleted ${all.length} item${all.length === 1 ? '' : 's'}${versioned.length ? '. Commit to share the deletion' : ''}.`);
    },
    { refreshAfter: true },
  );

  registerSvnCommand(
    context,
    services,
    'svnWorkflow.rename',
    async (targets) => {
      if (targets.length !== 1) {
        void vscode.window.showWarningMessage('SVN: rename works on one item at a time; use Move for several.');
        return;
      }
      const t = targets[0];
      const base = path.basename(t.fsPath);
      const name = await vscode.window.showInputBox({ title: `Rename ${base}`, prompt: 'New name (svn move, history is kept)', value: base, valueSelection: [0, base.length - path.extname(base).length], ignoreFocusOut: true, validateInput: (v) => validateRelativeName(v) });
      if (!name || name.trim() === base) return;
      await moveItems(t.repo, [t], path.join(path.dirname(t.fsPath), name.trim()), true);
    },
    { refreshAfter: true },
  );

  async function moveItems(repo: RepoEntry, items: SvnTarget[], dest: string, rename: boolean): Promise<void> {
    const single = rename;
    const pairs = items.map((t) => ({ t, to: single ? dest : path.join(dest, path.basename(t.fsPath)) }));
    for (const { t, to } of pairs) {
      if (!sameRepo(repo, to)) throw new Error(`"${to}" is outside the working copy of "${repo.name}". Subversion cannot move between working copies.`);
      if (fs.existsSync(to) && normalizePath(to) !== normalizePath(t.fsPath)) throw new Error(`"${to}" already exists.`);
    }
    await withRepoLocks([repo.name], () =>
      runOperation('Moving', async (signal) => {
        const { unversioned } = await versionedTargets(items);
        for (const { t, to } of pairs) {
          await fsp.mkdir(path.dirname(to), { recursive: true });
          if (unversioned.includes(t)) await fsp.rename(t.fsPath, to);
          else await ops.movePath(ctx(repo, signal), t.fsPath, to);
        }
      }),
    );
    notifySuccess(services, `Moved ${pairs.map((p) => path.basename(p.t.fsPath)).join(', ')} (svn move, history kept).`);
  }

  registerSvnCommand(
    context,
    services,
    'svnWorkflow.move',
    async (targets) => {
      const repo = targets[0].repo;
      const dest = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: vscode.Uri.file(path.dirname(targets[0].fsPath)), openLabel: 'Move here', title: 'Move to folder' });
      if (!dest?.[0]) return;
      await moveItems(repo, targets, dest[0].fsPath, false);
    },
    { refreshAfter: true },
  );

  registerSvnCommand(
    context,
    services,
    'svnWorkflow.copy',
    async (targets) => {
      const repo = targets[0].repo;
      let pairs: Array<{ from: string; to: string }>;
      if (targets.length === 1) {
        const base = path.basename(targets[0].fsPath);
        const name = await vscode.window.showInputBox({ title: `Copy ${base}`, prompt: 'Name or relative path of the copy (svn copy, history is kept)', value: copyName(base), ignoreFocusOut: true, validateInput: (v) => validateRelativeName(v, { allowParent: true }) });
        if (!name) return;
        pairs = [{ from: targets[0].fsPath, to: path.resolve(path.dirname(targets[0].fsPath), name.trim()) }];
      } else {
        const dest = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Copy here', title: 'Copy to folder' });
        if (!dest?.[0]) return;
        pairs = targets.map((t) => ({ from: t.fsPath, to: path.join(dest[0].fsPath, path.basename(t.fsPath)) }));
      }
      for (const p of pairs) {
        if (!sameRepo(repo, p.to)) throw new Error(`"${p.to}" is outside the working copy of "${repo.name}".`);
        if (fs.existsSync(p.to)) throw new Error(`"${p.to}" already exists.`);
      }
      const { unversioned } = await versionedTargets(targets);
      await withRepoLocks([repo.name], () =>
        runOperation('Copying', async (signal) => {
          for (const p of pairs) {
            if (unversioned.some((u) => u.fsPath === p.from)) await fsp.cp(p.from, p.to, { recursive: true });
            else await ops.copyPath(ctx(repo, signal), p.from, p.to);
          }
        }),
      );
      notifySuccess(services, `Copied ${pairs.length} item${pairs.length === 1 ? '' : 's'} (svn copy keeps history). Commit to share.`);
    },
    { refreshAfter: true },
  );

  registerSvnCommand(
    context,
    services,
    'svnWorkflow.mkdir',
    async (targets) => {
      const t = targets[0];
      const parent = isoDir(t.fsPath) ? t.fsPath : path.dirname(t.fsPath);
      const name = await vscode.window.showInputBox({ title: 'New Versioned Folder', prompt: `Folder name (relative to ${rel(t.repo, parent)})`, ignoreFocusOut: true, validateInput: (v) => validateRelativeName(v) });
      if (!name) return;
      const dir = path.join(parent, name.trim());
      const how = await withRepoLocks([t.repo.name], () => ops.mkdirPath(ctx(t.repo), dir));
      if (how) notifySuccess(services, `${how === 'created' ? 'Created' : 'Added existing'} folder ${rel(t.repo, dir)} under version control. Commit to share.`);
    },
    { refreshAfter: true },
  );

  // Missing + unversioned -> svn move / delete (VS Code Explorer or any outside rename)
  registerWc(
    context,
    services,
    'svnWorkflow.recordMoves',
    async (targets) => {
      for (const g of groupPathsByRepo(targets).values()) {
        const c = ctx(g.repo);
        const scans = await runOperation('Looking for moved and deleted files', async (signal) => {
          const out: Awaited<ReturnType<typeof ops.scanMissing>>[] = [];
          for (const p of g.paths) out.push(await ops.scanMissing(ctx(g.repo, signal), p));
          return out;
        });
        const moves = scans.flatMap((s) => s.plan.moves);
        const deletes = [...new Set(scans.flatMap((s) => s.plan.deletes))];
        if (!moves.length && !deletes.length) {
          void vscode.window.showInformationMessage(`SVN: no missing files found in ${g.repo.name}.`);
          continue;
        }
        const picks = await vscode.window.showQuickPick(
          [
            ...moves.map((m) => ({ label: `Move  ${rel(g.repo, m.from)}  ->  ${rel(g.repo, m.to)}`, description: 'same content, history kept', picked: true, move: m, del: undefined as string | undefined })),
            ...deletes.map((d) => ({ label: `Delete  ${rel(g.repo, d)}`, description: 'svn delete (missing on disk)', picked: true, move: undefined, del: d })),
          ],
          { canPickMany: true, title: `Record changes in ${g.repo.name}`, placeHolder: 'Missing files that were moved or deleted outside SVN' },
        );
        if (!picks?.length) continue;
        await withRepoLocks([g.repo.name], () =>
          runOperation('Recording moves and deletes', async () => {
            for (const p of picks) {
              if (p.move) await ops.recordMove(c, p.move.from, p.move.to);
              else if (p.del) await ops.deletePaths(c, [p.del]);
            }
          }),
        );
        notifySuccess(services, `Recorded ${picks.length} change${picks.length === 1 ? '' : 's'} in ${g.repo.name}.`);
      }
    },
    { palette: 'repo', refreshAfter: true },
  );

  registerExplorerWatchers(context, services, ctx);
}

/** Prefilled values for the checkout flow; anything given is not asked again. */
export interface CheckoutPrefill {
  url?: string;
  /** Numeric revision to check out (default HEAD). */
  revision?: number;
}

/** The whole interactive checkout (folder, depth, credentials, repo registration); used by the command. Nothing is registered: the new folder is offered for opening, and then it is the current working copy. */
export async function checkoutFlow(services: Services, prefill: CheckoutPrefill = {}): Promise<void> {
  let url: string;
  if (prefill.url) {
    const checked = checkServerUrl(prefill.url);
    if (checked.error) throw new Error(checked.error);
    url = checked.url as string;
  } else {
    const urlIn = await vscode.window.showInputBox({
      title: 'Checkout: repository URL',
      prompt: 'svn://, http(s):// or svn+ssh:// URL to check out (e.g. https://host/svn/project/trunk)',
      ignoreFocusOut: true,
      validateInput: (v) => checkServerUrl(v).error,
    });
    if (!urlIn) return;
    url = checkServerUrl(urlIn).url as string;
  }

  const parent = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Checkout into this folder', title: 'Parent folder for the working copy', defaultUri: vscode.workspace.workspaceFolders?.[0] ? vscode.Uri.file(path.dirname(vscode.workspace.workspaceFolders[0].uri.fsPath)) : undefined });
  if (!parent?.[0]) return;
  const folderName = await vscode.window.showInputBox({ title: 'Checkout: folder name', prompt: `Created inside ${parent[0].fsPath}. Leave empty to check out into the folder itself.`, value: defaultFolderName(url), ignoreFocusOut: true, validateInput: (v) => (v.trim() ? validateRelativeName(v) : undefined) });
  if (folderName === undefined) return;
  const target = folderName.trim() ? path.join(parent[0].fsPath, folderName.trim()) : parent[0].fsPath;
  if (fs.existsSync(target) && fs.readdirSync(target).length) {
    const ok = await vscode.window.showWarningMessage(`"${target}" is not empty.`, { modal: true, detail: 'Subversion checks out into it and keeps existing files as unversioned (files that exist in the repository too are reported as obstructed).' }, 'Checkout Anyway');
    if (!ok) return;
  }

  const depthPick = await vscode.window.showQuickPick(
    DEPTH_CHOICES.map((d) => ({ label: d.label, description: d.description, depth: d.depth })),
    { title: 'Checkout depth', placeHolder: 'Sparse checkout: pick less than "Fully recursive" and extend later with Set Depth' },
  );
  if (!depthPick) return;

  // Username, password and certificate trust already known for this server are reused.
  const known = services.servers.get(url);
  const sameServer = !!known.username || known.trustServerCert === true;
  const creds: Credentials = { username: known.username, password: (await services.passwords.get(url)) ?? undefined, trustServerCert: known.trustServerCert === true && /^https:/i.test(url) };
  const askCreds = async (reason?: string): Promise<boolean> => {
    const user = await vscode.window.showInputBox({ title: 'Checkout: username', prompt: reason ?? 'Username (leave empty for anonymous access)', value: creds.username ?? '', ignoreFocusOut: true });
    if (user === undefined) return false;
    creds.username = user.trim() || undefined;
    creds.password = undefined;
    if (creds.username) {
      const pw = await vscode.window.showInputBox({ title: `Checkout: password for ${creds.username}`, prompt: 'Stored in VS Code secret storage when the checkout succeeds', password: true, ignoreFocusOut: true });
      if (pw === undefined) return false;
      creds.password = pw || undefined;
    }
    return true;
  };
  if (!known.username && !(await askCreds())) return;

  let certFingerprint: string | undefined = sameServer ? known.trustedCertFingerprint : undefined;
  let result: { revision?: number } | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      result = await runOperation(`Checking out ${url}`, (signal) => ops.checkout({ client: services.client, url, target, depth: depthPick.depth, revision: prefill.revision ? String(prefill.revision) : undefined, credentials: { ...creds }, signal }));
      break;
    } catch (e) {
      if (e instanceof SvnError && e.kind === 'cancelled') {
        void vscode.window.showWarningMessage(`SVN: checkout cancelled. Partial files may remain in ${target}; run Cleanup there or delete the folder.`);
        return;
      }
      if (e instanceof SvnError && e.kind === 'certificate' && !creds.trustServerCert && /^https:/i.test(url)) {
        const c = await confirmCertificateTrust(url, 'The server certificate is not trusted. Trust it and retry?');
        if (!c.trusted) return;
        creds.trustServerCert = true;
        certFingerprint = c.fingerprint;
        continue;
      }
      if (e instanceof SvnError && e.kind === 'auth' && attempt < 3) {
        if (!(await askCreds('Authentication failed. Username (empty = anonymous):'))) return;
        continue;
      }
      throw e;
    }
  }

  const https = /^https:/i.test(url);
  await services.servers.set(url, { ...known, username: creds.username, trustServerCert: creds.trustServerCert && https ? true : undefined, trustedCertFingerprint: creds.trustServerCert && https ? certFingerprint : undefined });
  if (creds.password) await services.passwords.set(url, creds.password);
  services.logger.info(`Checked out ${url} (r${result?.revision ?? '?'}) to ${target}`);
  const next = await vscode.window.showInformationMessage(`SVN: checked out ${url} at r${result?.revision ?? '?'} into ${target}. Open the folder to work on it.`, 'Open Folder', 'Add to Workspace');
  if (next === 'Open Folder') await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target));
  else if (next === 'Add to Workspace') vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: vscode.Uri.file(target) });
}

function registerExplorerWatchers(context: vscode.ExtensionContext, services: Services, ctx: (repo: RepoEntry, s?: AbortSignal) => WcCtx): void {
  const mode = (): 'ask' | 'auto' | 'off' => vscode.workspace.getConfiguration(CONFIG_SECTION).get<'ask' | 'auto' | 'off'>('explorerFileOps', 'ask');

  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles(async (e) => {
      if (mode() === 'off') return;
      try {
        const found: Array<{ repo: RepoEntry; from: string; to: string }> = [];
        for (const f of e.files) {
          if (f.oldUri.scheme !== 'file' || f.newUri.scheme !== 'file') continue;
          const repo = services.resolver.resolve(f.oldUri.fsPath);
          if (!repo || services.resolver.resolve(f.newUri.fsPath)?.name !== repo.name) continue;
          if (path.basename(f.oldUri.fsPath) === '.svn') continue;
          const c = ctx(repo);
          if ((await ops.isMissing(c, f.oldUri.fsPath)) && (await ops.isUnversionedPath(c, f.newUri.fsPath))) found.push({ repo, from: f.oldUri.fsPath, to: f.newUri.fsPath });
        }
        if (!found.length) return;
        if (mode() === 'ask') {
          const pick = await vscode.window.showInformationMessage(
            `SVN: ${found.length === 1 ? `"${path.basename(found[0].from)}" was renamed or moved` : `${found.length} items were renamed or moved`} outside Subversion. Record as svn move (keeps history)?`,
            'Record as SVN Move',
            'Not Now',
          );
          if (pick !== 'Record as SVN Move') return;
        }
        for (const [name, items] of groupBy(found, (f) => f.repo.name)) {
          await withRepoLocks([name], async () => {
            for (const f of items) await ops.recordMove(ctx(f.repo), f.from, f.to);
          });
          services.incoming.requestRefresh({ repoName: name, remote: true });
        }
        services.logger.info(`Recorded ${found.length} Explorer rename(s) as svn move`);
      } catch (err) {
        await reportError(services, err);
      }
    }),
    vscode.workspace.onDidDeleteFiles(async (e) => {
      if (mode() === 'off') return;
      try {
        const found: Array<{ repo: RepoEntry; path: string }> = [];
        for (const u of e.files) {
          if (u.scheme !== 'file') continue;
          const repo = services.resolver.resolve(u.fsPath);
          if (repo && (await ops.isMissing(ctx(repo), u.fsPath))) found.push({ repo, path: u.fsPath });
        }
        if (!found.length) return;
        if (mode() === 'ask') {
          const pick = await vscode.window.showInformationMessage(
            `SVN: ${found.length === 1 ? `"${path.basename(found[0].path)}" was deleted` : `${found.length} versioned items were deleted`} outside Subversion. Record as svn delete?`,
            'Record as SVN Delete',
            'Not Now',
          );
          if (pick !== 'Record as SVN Delete') return;
        }
        for (const [name, items] of groupBy(found, (f) => f.repo.name)) {
          await withRepoLocks([name], () => ops.deletePaths(ctx(items[0].repo), items.map((i) => i.path)));
          services.incoming.requestRefresh({ repoName: name, remote: true });
        }
      } catch (err) {
        await reportError(services, err);
      }
    }),
  );
}

function groupBy<T>(list: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of list) m.set(key(i), [...(m.get(key(i)) ?? []), i]);
  return m;
}

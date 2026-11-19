import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { RefPick, layoutOf, pickRef } from '../branch/ui';
import { openCompare, type CompareContext } from '../compare/panel';
import { notifyConflicts } from '../conflict/notice';
import { encodeRepoPath } from '../history/model';
import type { SvnTarget } from '../pane/commands';
import type { RepoEntry } from '../repos/model';
import type { Services } from '../services';
import { localIgnoredAround } from '../localignore/model';
import { notifySuccess, notifyWarning, runOperation } from '../util/notify';
import { folderOf, registerRepoCommand, withRepoLock } from '../util/repoCommand';
import { ACCEPT_POLICIES, AcceptPolicy, MergeChange, MergeKind, MergeSpec, mergeTitle, parseRevSpec, summarizeMerge, compressRevs } from './model';
import { MixedRevisionError, explainMergeError, localChangeCount, logOfRevs, mergeinfoRevs, runMerge, updateTarget } from './ops';

export interface MergeEnv {
  services: Services;
  compare: CompareContext;
}

export interface MergePreset {
  kind?: MergeKind;
  source?: string;
  revs?: string;
}

const relOf = (repo: RepoEntry, p: string): string => path.relative(repo.localFolder, p).split(path.sep).join('/') || `(${repo.name} root)`;
const firstLine = (s?: string): string => (s ?? '').split(/\r?\n/)[0];

/** Merge target as svn sees it: a working copy folder, or a single file (cwd = its folder). */
interface WcTarget {
  repo: RepoEntry;
  /** Directory svn runs in; merge output paths are relative to it. */
  cwd: string;
  /** '.' for a folder, the file name for a file. */
  arg: string;
  fsPath: string;
  isFile: boolean;
}

function wcTarget(t: SvnTarget): WcTarget {
  const isFile = fs.existsSync(t.fsPath) && fs.statSync(t.fsPath).isFile();
  return isFile ? { repo: t.repo, cwd: path.dirname(t.fsPath), arg: path.basename(t.fsPath), fsPath: t.fsPath, isFile } : { repo: t.repo, cwd: folderOf(t.fsPath), arg: '.', fsPath: t.fsPath, isFile };
}

export async function runMergeWizard(env: MergeEnv, target: SvnTarget, preset: MergePreset = {}): Promise<void> {
  const { services } = env;
  const t = wcTarget(target);
  const { repo } = t;
  const { layout, url: wcUrl } = await layoutOf(services, repo, t.cwd);
  const ctx = { client: services.client, repo, cwd: t.cwd };

  let chosenKind = preset.kind;
  if (!chosenKind) {
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(sync) Sync', description: 'merge all eligible changes from another branch (e.g. trunk into this branch)', mk: 'sync' as MergeKind },
        { label: '$(git-pull-request) Revision range / cherry-pick', description: 'merge chosen revisions (-c) from a source', mk: 'range' as MergeKind },
        { label: '$(git-merge) Reintegrate', description: 'merge a finished branch back into this working copy (usually trunk)', mk: 'reintegrate' as MergeKind },
      ],
      { title: `Merge into ${wcUrl}`, placeHolder: 'What kind of merge?' },
    );
    if (!pick) return;
    chosenKind = pick.mk;
  }
  const kind: MergeKind = chosenKind;

  let source = preset.source;
  if (!source) {
    const ref: RefPick | undefined = await pickRef(services, repo, layout, {
      title: kind === 'reintegrate' ? 'Branch to reintegrate into this working copy' : `Merge source for ${wcUrl}`,
      exclude: wcUrl,
      kinds: kind === 'reintegrate' ? ['branch'] : undefined,
    });
    if (!ref) return;
    source = ref.url;
  }
  if (source.replace(/\/+$/, '').toLowerCase() === wcUrl.toLowerCase()) {
    void vscode.window.showWarningMessage('SVN: the merge source is the working copy\'s own URL. Pick a different source.');
    return;
  }

  let revs = preset.revs;
  if (kind === 'range' && !revs) {
    revs = await pickRevisions(env, { ...ctx }, source, t.arg);
    if (!revs) return;
  }

  const opts = await vscode.window.showQuickPick(
    [
      { label: 'Preview first (dry run)', description: 'list the affected files and compare them before changing anything', id: 'dry', picked: true },
      { label: 'Record only', description: 'only record mergeinfo, do not change files', id: 'record' },
      { label: 'Ignore ancestry', description: 'merge unrelated trees by content (rarely needed)', id: 'ancestry' },
    ],
    { title: `Merge options: ${mergeTitle({ kind, source, target: t.arg, revs })}`, canPickMany: true, placeHolder: 'Select options, then press Enter' },
  );
  if (!opts) return;
  const has = (id: string): boolean => opts.some((o) => o.id === id);

  const acc = await vscode.window.showQuickPick(
    ACCEPT_POLICIES.map((p) => ({
      label: p,
      description: p === 'postpone' ? 'leave conflicts for me to resolve (default)' : p.startsWith('mine') ? 'keep my local version where it conflicts' : p.startsWith('theirs') ? 'take the merged-in version where it conflicts' : 'use the base version',
      policy: p as AcceptPolicy,
    })),
    { title: 'How should conflicts be handled?', placeHolder: 'postpone is the safe choice' },
  );
  if (!acc) return;

  const spec: MergeSpec = { kind, source, target: t.arg, revs, recordOnly: has('record'), ignoreAncestry: has('ancestry'), accept: acc.policy };

  if (has('dry')) {
    const res = await runOperation('Previewing merge', (signal) => runMerge({ ...ctx, signal }, { ...spec, dryRun: true })).catch((e) => {
      throw explainMergeError(e) ?? e;
    });
    if (!res.changes.length && !res.conflicts.length && !res.recordedMergeinfo) {
      void vscode.window.showInformationMessage('SVN: nothing to merge. The source has no changes missing here.');
      return;
    }
    if (!(await showPreview(env, t, spec, res.changes, res.conflicts, summarizeMerge(res)))) return;
  }
  await executeMerge(env, t, spec);
}

/** Lists what a dry run would touch; picking a file opens compare. Returns true when the user chooses to run the merge. */
async function showPreview(env: MergeEnv, t: WcTarget, spec: MergeSpec, changes: MergeChange[], conflicts: string[], summary: string): Promise<boolean> {
  type Item = vscode.QuickPickItem & { run?: boolean; change?: MergeChange };
  const conflicted = new Set(conflicts.map((c) => c.toLowerCase()));
  for (;;) {
    const items: Item[] = [
      { label: '$(play) Run this merge', description: summary, detail: conflicts.length ? `${conflicts.length} conflict(s) expected; they are left for you to resolve unless you chose another policy.` : undefined, run: true },
      { label: 'Affected files (select one to compare it with the source)', kind: vscode.QuickPickItemKind.Separator },
      ...changes.map((c) => ({
        label: `${c.action.trim() || ' '}${c.props.trim() ? `/${c.props.trim()}` : ''}  ${c.path}`,
        description: conflicted.has(c.path.toLowerCase()) ? 'conflict' : undefined,
        change: c,
      })),
    ];
    const pick = await vscode.window.showQuickPick(items, { title: `Preview: ${mergeTitle({ ...spec, dryRun: true })}`, ignoreFocusOut: true, matchOnDescription: true, placeHolder: 'Nothing has been changed yet' });
    if (!pick) return false;
    if (pick.run) return true;
    if (pick.change) await compareWithSource(env, t, spec.source, pick.change);
  }
}

/** Left: the working copy file; right: the same file in the merge source (HEAD). */
async function compareWithSource(env: MergeEnv, t: WcTarget, source: string, ch: MergeChange): Promise<void> {
  const abs = path.resolve(t.cwd, ch.path);
  const exists = fs.existsSync(abs);
  if (exists && fs.statSync(abs).isDirectory()) {
    void vscode.window.showInformationMessage(`SVN: ${ch.path} is a folder; only files can be compared.`);
    return;
  }
  const rel = t.isFile ? '' : encodeRepoPath(path.relative(t.cwd, abs).split(path.sep).join('/'));
  const url = rel ? `${source.replace(/\/+$/, '')}/${rel}` : source;
  const name = path.basename(abs);
  const left = exists ? ({ kind: 'local', fsPath: abs, repoName: t.repo.name } as const) : ({ kind: 'text', text: '', name, label: 'Working copy (does not exist)' } as const);
  const right = ch.action === 'D' ? ({ kind: 'text', text: '', name, label: 'Source (deleted by merge)' } as const) : ({ kind: 'rev', repoName: t.repo.name, target: url, rev: 'HEAD', label: `Source HEAD` } as const);
  await openCompare(env.compare, { left, right, title: `${name} (Working copy ↔ merge source)` });
}

/** Multi-select of the source's eligible revisions, or typed revisions. Returns the `-c` argument. */
async function pickRevisions(env: MergeEnv, c: { client: Services['client']; repo: RepoEntry; cwd: string }, source: string, target: string): Promise<string | undefined> {
  const found = await runOperation('Finding eligible revisions', async (signal) => {
    const eligible = await mergeinfoRevs({ ...c, signal }, 'eligible', source, target);
    const log = await logOfRevs({ ...c, signal }, source, eligible.slice(-300));
    return { eligible, log };
  });
  const manual = '$(edit) Type revisions or a range instead...';
  if (found.eligible.length) {
    const byRev = new Map(found.log.map((e) => [e.revision, e]));
    const items: Array<vscode.QuickPickItem & { rev?: number }> = [...found.eligible]
      .sort((a, b) => b - a)
      .slice(0, 300)
      .map((r) => {
        const e = byRev.get(r);
        return { label: `r${r}`, description: e ? `${e.author ?? ''} ${(e.date ?? '').slice(0, 10)}`.trim() : '', detail: firstLine(e?.message), rev: r };
      });
    items.unshift({ label: manual });
    const picks = await vscode.window.showQuickPick(items, { title: `Eligible revisions from ${source} (${found.eligible.length} not yet merged)`, canPickMany: true, matchOnDescription: true, matchOnDetail: true, placeHolder: 'Select the revisions to merge' });
    if (!picks) return undefined;
    const chosen = picks.filter((p) => p.rev !== undefined).map((p) => p.rev as number);
    if (chosen.length && !picks.some((p) => p.label === manual)) return compressRevs(chosen);
  } else {
    void vscode.window.showInformationMessage('SVN: no eligible revisions found (everything is merged). You can still enter revisions manually.');
  }
  const v = await vscode.window.showInputBox({ title: 'Revisions to merge', prompt: 'Revision, range or list, e.g. 12, 12-15, 12,14,20-22', ignoreFocusOut: true, validateInput: (s) => ('error' in parseRevSpec(s) ? (parseRevSpec(s) as { error: string }).error : undefined) });
  if (!v) return undefined;
  const r = parseRevSpec(v);
  return 'spec' in r ? r.spec : undefined;
}

/** The real merge: lock, local-change check, progress, summary and conflict hand-off. */
export async function executeMerge(env: MergeEnv, t: WcTarget, spec: MergeSpec): Promise<boolean> {
  const { services } = env;
  const { repo } = t;
  const listed = localIgnoredAround([t.fsPath]);
  if (listed.length) {
    const ok = await vscode.window.showWarningMessage(
      `${listed.length} locally ignored path(s) lie inside the merge target.`,
      { modal: true, detail: `A merge cannot skip files, so it may change them:\n${listed.slice(0, 8).map((p) => relOf(repo, p)).join('\n')}${listed.length > 8 ? '\n...' : ''}` },
      'Merge Anyway',
    );
    if (ok !== 'Merge Anyway') return false;
  }
  const local = await localChangeCount({ client: services.client, repo, cwd: t.cwd }, t.arg).catch(() => 0);
  if (local > 0 || spec.kind === 'reintegrate') {
    const detail =
      (local > 0 ? `The working copy has ${local} locally changed item(s); the merge result will be mixed with them. ` : '') +
      (spec.kind === 'reintegrate' ? 'Reintegrate needs a working copy that is fully updated, without switched subtrees. ' : '') +
      'Nothing is committed: you review and commit the result yourself.';
    const ok = await vscode.window.showWarningMessage(`Merge ${spec.kind === 'range' ? `r${spec.revs}` : spec.kind} from ${spec.source} into ${relOf(repo, t.fsPath)}?`, { modal: true, detail }, 'Merge');
    if (ok !== 'Merge') return false;
  }
  const attempt = (): Promise<Awaited<ReturnType<typeof runMerge>>> =>
    runOperation(mergeTitle(spec), (signal) => runMerge({ client: services.client, repo, cwd: t.cwd, signal }, spec)).catch((e) => {
      throw explainMergeError(e) ?? e;
    });
  const res = await withRepoLock(repo.name, async () => {
    try {
      return await attempt();
    } catch (e) {
      if (!(e instanceof MixedRevisionError)) throw e;
      const ok = await vscode.window.showWarningMessage('The working copy has mixed revisions (for example after a commit).', { modal: true, detail: 'Merging needs one revision throughout. Update the working copy first, then the merge is repeated.' }, 'Update and Merge');
      if (ok !== 'Update and Merge') return undefined;
      await runOperation('Updating before merge', (signal) => updateTarget({ client: services.client, repo, cwd: t.cwd, signal }, t.arg));
      return attempt();
    }
  });
  if (!res) return false;
  services.incoming.requestRefresh({ repoName: repo.name, remote: true });
  const where = relOf(repo, t.fsPath);
  const head = `Merged ${spec.kind === 'range' ? `r${spec.revs}` : spec.kind} from ${spec.source} into ${where}: ${summarizeMerge(res)}.`;
  if (res.conflicts.length) await notifyConflicts(services, `${head} Conflicts in ${res.conflicts.slice(0, 5).join(', ')}${res.conflicts.length > 5 ? ', ...' : ''}. Resolve them from the SVN pane.`);
  else if (res.skipped.length) await notifyWarning(services, `${head} Skipped: ${res.skipped.slice(0, 5).join(', ')}. Review and commit.`);
  else notifySuccess(services, `${head} Review and commit.`);
  return true;
}

/** Eligible and merged revisions of a source for this target; an eligible one can be merged straight away. */
export async function showMergeInfo(env: MergeEnv, target: SvnTarget): Promise<void> {
  const { services } = env;
  const t = wcTarget(target);
  const { layout, url: wcUrl } = await layoutOf(services, t.repo, t.cwd);
  const ref = await pickRef(services, t.repo, layout, { title: `Merge info for ${wcUrl}`, placeHolder: 'Source to compare with', exclude: wcUrl });
  if (!ref) return;
  const c = { client: services.client, repo: t.repo, cwd: t.cwd };
  const data = await runOperation('Reading mergeinfo', async (signal) => {
    const [eligible, merged] = await Promise.all([mergeinfoRevs({ ...c, signal }, 'eligible', ref.url, t.arg), mergeinfoRevs({ ...c, signal }, 'merged', ref.url, t.arg)]);
    const log = await logOfRevs({ ...c, signal }, ref.url, [...eligible, ...merged].slice(-400));
    return { eligible, merged, log: new Map(log.map((e) => [e.revision, e])) };
  });
  type Item = vscode.QuickPickItem & { rev?: number; eligible?: boolean };
  const row = (r: number, eligible: boolean): Item => {
    const e = data.log.get(r);
    return { label: `r${r}`, description: e ? `${e.author ?? ''} ${(e.date ?? '').slice(0, 10)}`.trim() : '', detail: firstLine(e?.message), rev: r, eligible };
  };
  const items: Item[] = [
    { label: `Eligible: ${data.eligible.length} revision(s) not yet merged (select one to merge it)`, kind: vscode.QuickPickItemKind.Separator },
    ...[...data.eligible].reverse().slice(0, 400).map((r) => row(r, true)),
    { label: `Merged: ${data.merged.length} revision(s)`, kind: vscode.QuickPickItemKind.Separator },
    ...[...data.merged].reverse().slice(0, 400).map((r) => row(r, false)),
  ];
  const pick = await vscode.window.showQuickPick(items, { title: `Merge info: ${ref.url} -> ${wcUrl}`, matchOnDescription: true, matchOnDetail: true });
  if (pick?.eligible && pick.rev !== undefined) await runMergeWizard(env, target, { kind: 'range', source: ref.url, revs: String(pick.rev) });
}

/**
 * History view action: cherry-pick `-c REV` from the history URL into a working copy
 * (the same repository's other working copies are offered, or a folder is browsed).
 */
export async function mergeRevisionFromHistory(env: MergeEnv, repo: RepoEntry, fsPath: string, sourceUrl: string, rev: number): Promise<void> {
  const { services } = env;
  const relFromRoot = path.relative(repo.localFolder, fsPath);
  const srcRoot = (await services.client.info(sourceUrl, { repoName: repo.name, cwd: repo.localFolder })).repositoryRoot.replace(/\/+$/, '');
  type Cand = vscode.QuickPickItem & { wc?: string; repo?: RepoEntry; browse?: boolean };
  const cands: Cand[] = [];
  for (const r of services.repos.list()) {
    const i = await services.client.info(r.localFolder, { repoName: r.name, cwd: r.localFolder }).catch(() => undefined);
    if (i && i.repositoryRoot.replace(/\/+$/, '').toLowerCase() === srcRoot.toLowerCase()) cands.push({ label: r.name, description: `${r.localFolder}  (${i.url})`, wc: r.localFolder, repo: r });
  }
  cands.push({ label: '$(folder-opened) Choose a working copy folder...', browse: true });
  const pick = await vscode.window.showQuickPick(cands, { title: `Merge r${rev} from ${sourceUrl} into which working copy?`, placeHolder: 'The revision is applied as a local change; nothing is committed' });
  if (!pick) return;
  let wcRoot = pick.wc;
  let tRepo = pick.repo;
  if (pick.browse) {
    const f = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: 'Working copy folder' });
    if (!f?.[0]) return;
    wcRoot = f[0].fsPath;
    tRepo = services.resolver.require(wcRoot);
  }
  if (!wcRoot || !tRepo) return;
  const dest = relFromRoot && !pick.browse ? path.join(wcRoot, relFromRoot) : wcRoot;
  const t = wcTarget({ repo: tRepo, fsPath: dest });
  const destUrl = (await services.client.info(dest, { repoName: tRepo.name, cwd: t.cwd })).url.replace(/\/+$/, '').toLowerCase();
  if (destUrl === sourceUrl.replace(/\/+$/, '').toLowerCase()) {
    void vscode.window.showWarningMessage(`SVN: that working copy is at ${sourceUrl} itself, so r${rev} is already part of it. Pick a working copy of another branch.`);
    return;
  }
  await executeMerge(env, t, { kind: 'range', source: sourceUrl, target: t.arg, revs: String(rev), accept: 'postpone' });
}

export function registerMerge(context: vscode.ExtensionContext, services: Services, compare: CompareContext): MergeEnv {
  const env: MergeEnv = { services, compare };
  const reg = (id: string, h: (t: SvnTarget) => Promise<void>): void => registerRepoCommand(context, services, id, h, { refreshAfter: true });
  reg('svnWorkflow.merge', (t) => runMergeWizard(env, t));
  reg('svnWorkflow.mergeSync', (t) => runMergeWizard(env, t, { kind: 'sync' }));
  reg('svnWorkflow.mergeRevisions', (t) => runMergeWizard(env, t, { kind: 'range' }));
  reg('svnWorkflow.reintegrate', (t) => runMergeWizard(env, t, { kind: 'reintegrate' }));
  reg('svnWorkflow.mergeInfo', (t) => showMergeInfo(env, t));
  return env;
}

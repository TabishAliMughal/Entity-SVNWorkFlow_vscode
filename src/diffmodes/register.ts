import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { detectLayout } from '../branch/model';
import { layoutSettings, pickRef } from '../branch/ui';
import { compareLocalWithRev } from '../compare/commands';
import { decodeContent } from '../compare/content';
import { fetchContent, resolveCatTarget, type Rev } from '../compare/fetch';
import { openCompare, type CompareContext } from '../compare/panel';
import { pickRevision } from '../compare/revisions';
import type { Source } from '../compare/sources';
import { sourceName } from '../compare/sources';
import { contextLines } from '../patch/register';
import { deliverDiff } from '../patch/output';
import { unifiedFileDiff } from '../patch/unified';
import { registerSvnCommand, type SvnTarget } from '../pane/commands';
import type { Services } from '../services';
import { pegSafe } from '../svn/client';
import { parseLog } from '../svn/xml';
import { runOperation } from '../util/notify';
import { FolderMode, SummaryEntry, modeTitle, pairFor, parseDiffSummary, revSource, samePathIn, summarizeArgs } from './model';

const isDirPath = (p: string): Promise<boolean> => fs.stat(p).then((s) => s.isDirectory(), () => false);

const dec = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** HEAD, a recent revision of `target`, or a typed number. BASE is not offered: both sides here are server revisions. */
async function pickServerRev(services: Services, repoName: string, target: string, title: string): Promise<number | 'HEAD' | undefined> {
  type Item = vscode.QuickPickItem & { rev?: number | 'HEAD'; manual?: boolean };
  const items: Item[] = [{ label: 'HEAD', description: 'latest on the server', rev: 'HEAD' }, { label: '$(edit) Enter revision number...', manual: true }];
  try {
    const r = await services.client.run(['log', '-l', '40', '--', pegSafe(target)], { repoName, xml: true });
    for (const e of parseLog(r.text)) items.push({ label: `r${e.revision}`, description: `${e.author ?? ''} ${(e.date ?? '').slice(0, 10)}`.trim(), detail: (e.message ?? '').split(/\r?\n/)[0], rev: e.revision });
  } catch (e) {
    services.logger.warn(`svn log for revision picker failed: ${(e as Error).message}`);
  }
  const pick = await vscode.window.showQuickPick(items, { title, matchOnDescription: true, matchOnDetail: true });
  if (!pick) return undefined;
  if (!pick.manual) return pick.rev;
  const v = await vscode.window.showInputBox({ title, prompt: 'Revision number or HEAD', validateInput: (s) => (/^(\d+|HEAD)$/i.test(s.trim()) ? undefined : 'Enter a number or HEAD') });
  if (!v) return undefined;
  return /^head$/i.test(v.trim()) ? 'HEAD' : Number(v.trim());
}

async function sourceText(services: Services, repoName: string, s: Source): Promise<{ text: string; binary: boolean }> {
  if (s.kind === 'text') return { text: s.text, binary: false };
  if (s.kind === 'local') {
    const d = decodeContent(await fs.readFile(s.fsPath).catch(() => Buffer.alloc(0)));
    return { text: d.text, binary: d.binary };
  }
  const f = await fetchContent(services.client, { repoName, target: s.target, rev: s.rev });
  return { text: f.text, binary: f.binary };
}

/** One patch for every changed file of a folder diff, written by our engine from the two sides. */
async function exportModeDiff(services: Services, repoName: string, mode: FolderMode, root: string, entries: SummaryEntry[], name: string): Promise<void> {
  const parts: string[] = [];
  const skipped: string[] = [];
  await runOperation('Generating unified diff', async (signal) => {
    for (const e of entries) {
      if (signal.aborted) break;
      const rel = dec(e.rel);
      const p = pairFor(mode, repoName, root, e);
      const [a, b] = await Promise.all([sourceText(services, repoName, p.left), sourceText(services, repoName, p.right)]);
      if (a.binary || b.binary) {
        skipped.push(rel);
        continue;
      }
      // Head/rev modes put the working copy on the left; a patch goes server -> working copy.
      const flip = mode.mode === 'head' || mode.mode === 'rev';
      const [oldT, newT] = flip ? [b.text, a.text] : [a.text, b.text];
      const label = (s: Source): string => (s.kind === 'text' ? '(nonexistent)' : s.kind === 'local' ? '(working copy)' : `(revision ${s.rev})`);
      const [oldS, newS] = flip ? [p.right, p.left] : [p.left, p.right];
      parts.push(unifiedFileDiff(rel, oldT, newT, { context: contextLines(), oldLabel: label(oldS), newLabel: label(newS) }));
    }
  });
  const text = parts.filter(Boolean).join('');
  if (!text) {
    void vscode.window.showInformationMessage('SVN: No text differences to export.');
    return;
  }
  if (skipped.length) void vscode.window.showWarningMessage(`SVN: ${skipped.length} binary file(s) are not part of the unified diff: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', ...' : ''}`);
  await deliverDiff(services, Buffer.from(text, 'utf8'), { defaultName: `${name}.diff`, title: 'Unified diff of this comparison' });
}

/** Changed files of a folder/repo diff; picking one opens the shared compare view. */
export async function folderDiff(services: Services, ctx: CompareContext, repoName: string, root: string, mode: FolderMode): Promise<void> {
  const run = await runOperation('Listing changed files', (signal) =>
    services.client.run(summarizeArgs(mode), { repoName, cwd: root, xml: true, signal, timeoutMs: 5 * 60_000 }),
  );
  const entries = parseDiffSummary(run.text, mode).filter((e) => e.kind !== 'dir');
  const title = modeTitle(mode, path.basename(root) || repoName);
  if (!entries.length) {
    void vscode.window.showInformationMessage(`SVN: No differences (${title}).`);
    return;
  }
  type Item = vscode.QuickPickItem & { entry?: SummaryEntry; exportAll?: boolean };
  const letter = (e: SummaryEntry): string => (e.item === 'added' ? 'A' : e.item === 'deleted' ? 'D' : e.item === 'none' ? ' ' : 'M');
  for (;;) {
    const items: Item[] = [
      { label: '$(export) Export all as one unified diff...', description: `${entries.length} file(s)`, exportAll: true },
      { label: 'Changed files (select one to compare)', kind: vscode.QuickPickItemKind.Separator },
      ...entries.map((e) => ({ label: `${letter(e)}${e.props === 'modified' ? 'M' : ' '}  ${dec(e.rel)}`, description: e.item === 'none' ? 'properties only' : undefined, entry: e })),
    ];
    const pick = await vscode.window.showQuickPick(items, { title, placeHolder: `${entries.length} changed file(s)`, matchOnDescription: true });
    if (!pick) return;
    if (pick.exportAll) {
      await exportModeDiff(services, repoName, mode, root, entries, path.basename(root) || repoName);
      continue;
    }
    if (!pick.entry) continue;
    const p = pairFor(mode, repoName, root, pick.entry);
    const name = path.posix.basename(dec(pick.entry.rel));
    await openCompare(ctx, { left: p.left, right: p.right, editableSide: p.editableSide, title: `${name} (${title})` });
  }
}

async function workingCopyBaseCompare(ctx: CompareContext, t: SvnTarget): Promise<void> {
  const name = path.basename(t.fsPath);
  await openCompare(ctx, {
    left: { kind: 'local', fsPath: t.fsPath, repoName: t.repo.name },
    right: { kind: 'rev', repoName: t.repo.name, target: t.fsPath, rev: 'BASE', label: 'BASE (last update)' },
    editableSide: 'left',
    title: `${name} (Working Copy ↔ BASE)`,
  });
}

async function urlsFlow(services: Services, ctx: CompareContext, t: SvnTarget): Promise<void> {
  const isDir = await isDirPath(t.fsPath);
  const info = await services.client.info(t.fsPath, { repoName: t.repo.name, cwd: t.repo.localFolder });
  const layout = detectLayout(info.repositoryRoot, info.url, layoutSettings());
  const wcUrl = info.url.replace(/\/+$/, '');
  const ref = await pickRef(services, t.repo, layout, { title: `Compare ${path.basename(t.fsPath)} with which trunk, branch, tag or URL?` });
  if (!ref) return;
  const other = samePathIn(wcUrl, layout, ref.url) ?? ref.url;
  const revs = await vscode.window.showQuickPick(
    [
      { label: 'HEAD on both sides', id: 'head' },
      { label: 'Choose revisions...', id: 'pick' },
    ],
    { title: `${wcUrl}  vs  ${other}`, placeHolder: 'Which revisions?' },
  );
  if (!revs) return;
  let oldRev: Rev = 'HEAD';
  let newRev: Rev = 'HEAD';
  if (revs.id === 'pick') {
    const a = await pickServerRev(services, t.repo.name, wcUrl, `Left side ${wcUrl}: which revision?`);
    if (a === undefined) return;
    const b = await pickServerRev(services, t.repo.name, other, `Right side ${other}: which revision?`);
    if (b === undefined) return;
    oldRev = a;
    newRev = b;
  }
  if (isDir) {
    await folderDiff(services, ctx, t.repo.name, t.fsPath, { mode: 'urls', oldUrl: wcUrl, oldRev, newUrl: other, newRev });
    return;
  }
  const name = path.basename(t.fsPath);
  await openCompare(ctx, {
    left: revSource(t.repo.name, wcUrl, oldRev, `${wcUrl}@${oldRev}`),
    right: revSource(t.repo.name, other, newRev, `${other}@${newRev}`),
    title: `${name} (${layout.name ?? layout.kind}@${oldRev} ↔ ${ref.name ?? ref.kind}@${newRev})`,
  });
}

async function revisionsFlow(services: Services, ctx: CompareContext, t: SvnTarget): Promise<void> {
  const info = await services.client.info(t.fsPath, { repoName: t.repo.name, cwd: t.repo.localFolder });
  const url = info.url.replace(/\/+$/, '');
  const name = path.basename(t.fsPath);
  const a = await pickServerRev(services, t.repo.name, url, `${name}: first (left) revision`);
  if (a === undefined) return;
  const b = await pickServerRev(services, t.repo.name, url, `${name}: second (right) revision`);
  if (b === undefined) return;
  if (await isDirPath(t.fsPath)) {
    await folderDiff(services, ctx, t.repo.name, t.fsPath, { mode: 'urls', oldUrl: url, oldRev: a, newUrl: url, newRev: b });
    return;
  }
  await openCompare(ctx, { left: revSource(t.repo.name, url, a), right: revSource(t.repo.name, url, b), title: `${name} (r${a} ↔ r${b})` });
}

async function revisionFlow(services: Services, ctx: CompareContext, t: SvnTarget): Promise<void> {
  const dir = await isDirPath(t.fsPath);
  const target = dir ? t.fsPath : await resolveCatTarget(services.client, t.repo.name, t.fsPath);
  const rev = await pickRevision(services, t.repo.name, target);
  if (rev === undefined) return;
  if (!dir) return compareLocalWithRev(ctx, { repoName: t.repo.name, fsPath: t.fsPath }, rev);
  const mode: FolderMode = rev === 'HEAD' ? { mode: 'head' } : rev === 'BASE' ? { mode: 'base' } : { mode: 'rev', rev };
  await folderDiff(services, ctx, t.repo.name, t.fsPath, mode);
}

export function registerDiffModes(context: vscode.ExtensionContext, services: Services, ctx: CompareContext): void {
  const first = (targets: SvnTarget[]): SvnTarget => {
    if (!targets[0]) throw new Error('Select a file or folder first.');
    return targets[0];
  };
  registerSvnCommand(context, services, 'svnWorkflow.diff.base', async (targets) => {
    const t = first(targets);
    if (await isDirPath(t.fsPath)) await folderDiff(services, ctx, t.repo.name, t.fsPath, { mode: 'base' });
    else await workingCopyBaseCompare(ctx, t);
  });
  registerSvnCommand(context, services, 'svnWorkflow.diff.head', async (targets) => {
    const t = first(targets);
    if (await isDirPath(t.fsPath)) await folderDiff(services, ctx, t.repo.name, t.fsPath, { mode: 'head' });
    else await compareLocalWithRev(ctx, { repoName: t.repo.name, fsPath: t.fsPath }, 'HEAD', t.item?.repoItem === 'deleted');
  });
  registerSvnCommand(context, services, 'svnWorkflow.diff.revision', (targets) => revisionFlow(services, ctx, first(targets)));
  registerSvnCommand(context, services, 'svnWorkflow.diff.revisions', (targets) => revisionsFlow(services, ctx, first(targets)));
  registerSvnCommand(context, services, 'svnWorkflow.diff.urls', (targets) => urlsFlow(services, ctx, first(targets)));

  let selected: vscode.Uri | undefined;
  const setSelected = (u: vscode.Uri | undefined): Thenable<unknown> => {
    selected = u;
    return vscode.commands.executeCommand('setContext', 'svnWorkflow.hasCompareSelection', !!u);
  };
  const fileUri = (arg: unknown): vscode.Uri => {
    const u = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    if (!u || u.scheme !== 'file') throw new Error('Select a file in the Explorer, or open one, first.');
    return u;
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('svnWorkflow.diff.selectForCompare', async (arg?: unknown) => {
      try {
        const u = fileUri(arg);
        if (await isDirPath(u.fsPath)) throw new Error('Select a file, not a folder.');
        await setSelected(u);
        void vscode.window.showInformationMessage(`SVN: Selected ${path.basename(u.fsPath)} for compare. Run "Compare with Selected" on another file.`);
      } catch (e) {
        void vscode.window.showWarningMessage((e as Error).message);
      }
    }),
    vscode.commands.registerCommand('svnWorkflow.diff.compareWithSelected', async (arg?: unknown) => {
      try {
        if (!selected) throw new Error('Run "Select for Compare" on the first file.');
        const right = fileUri(arg);
        if (await isDirPath(right.fsPath)) throw new Error('Select a file, not a folder.');
        const left = selected;
        const l: Source = { kind: 'local', fsPath: left.fsPath, label: left.fsPath };
        const r: Source = { kind: 'local', fsPath: right.fsPath, label: right.fsPath };
        await openCompare(ctx, { left: l, right: r, editableSide: 'left', title: `${sourceName(l)} ↔ ${sourceName(r)}` });
      } catch (e) {
        void vscode.window.showWarningMessage((e as Error).message);
      }
    }),
  );
}

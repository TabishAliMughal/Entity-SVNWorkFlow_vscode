import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { openCompare, type CompareContext } from '../compare/panel';
import type { Services } from '../services';
import { notifySuccess, notifyWarning, runOperation } from '../util/notify';
import { withRepoLock } from '../util/repoCommand';
import { registerSelectionCommand, type Selection } from '../util/selectionCommand';
import { BuildResult, PatchEntry, buildPatch, collectChanges, describeBuild, planEntry, posixRel } from './create';
import { PatchOutcomeEntry, REJECT_SUFFIX, stripPath } from './model';
import { runPatch, summarizeOutcome } from './ops';
import { deliverDiff } from './output';
import { FilePatch, applyFilePatch, parseUnifiedDiff } from './parse';

export function contextLines(): number {
  const n = vscode.workspace.getConfiguration('svnWorkflow.diff').get<number>('contextLines', 3);
  return Number.isFinite(n) ? Math.min(50, Math.max(0, Math.floor(n))) : 3;
}

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Changes under the selection, optionally narrowed by a checklist, as one patch. */
export async function createPatchFlow(services: Services, sel: Selection, o: { checklist: 'auto' | 'always'; what: string }): Promise<void> {
  const { repo } = sel;
  const all = await runOperation('Collecting changes', (signal) => collectChanges(services.client, repo, sel.paths, signal));
  const usable = all.filter((e) => planEntry(e).how !== 'skip');
  const unversioned = all.filter((e) => e.item === 'unversioned').length;
  if (!usable.length) {
    void vscode.window.showInformationMessage(`SVN: No changes to put in a patch${unversioned ? ` (${unversioned} unversioned file(s) are not included; add them first)` : ''}.`);
    return;
  }
  let chosen: PatchEntry[] = usable;
  const ask = o.checklist === 'always' || sel.whole || sel.paths.some(isDir);
  if (ask && usable.length > 0) {
    const picks = await vscode.window.showQuickPick(
      usable.map((e) => ({ label: path.basename(e.path), description: `${posixRel(repo.localFolder, e.path)}  (${e.item}${e.props === 'modified' ? ', properties' : ''})`, picked: true, entry: e })),
      { canPickMany: true, title: `${o.what}: which changes?`, placeHolder: `${usable.length} change(s); uncheck what to leave out`, matchOnDescription: true },
    );
    if (!picks?.length) return;
    chosen = picks.map((p) => p.entry);
  }
  const built = await runOperation('Generating patch', (signal) => buildPatch(services.client, repo, chosen, { context: contextLines(), binary: 'svn', signal }));
  if (!built.bytes.length) {
    void vscode.window.showInformationMessage('SVN: Nothing to write: the selected changes produce an empty diff.');
    return;
  }
  reportBuild(services, built, unversioned);
  await deliverDiff(services, built.bytes, { defaultName: `${repo.name}.patch`, defaultDir: path.dirname(repo.localFolder), title: `${o.what} (${chosen.length} file(s))` });
}

function reportBuild(services: Services, b: BuildResult, unversioned: number): void {
  const extra = unversioned ? `; ${unversioned} unversioned file(s) not included` : '';
  const svnNote = b.viaSvn.length ? ' Property changes, copies and binary files come from `svn diff --git`; svn patch applies them, other tools may not.' : '';
  services.logger.info(`Patch: ${describeBuild(b)}${extra}`);
  void vscode.window.showInformationMessage(`SVN: Patch built from ${describeBuild(b)}${extra}.${svnNote}`);
}

interface ApplyOptions {
  reverse: boolean;
  strip: number;
}

async function pickApplyOptions(): Promise<ApplyOptions | undefined> {
  type Item = vscode.QuickPickItem & { id: 'reverse' | 'strip' };
  const picks = await vscode.window.showQuickPick<Item>(
    [
      { id: 'reverse', label: 'Reverse patch', description: 'undo the changes in the patch (svn patch --reverse-diff)' },
      { id: 'strip', label: 'Strip leading path components...', description: 'for patches with a prefix such as a/ or trunk/ (svn patch --strip N)' },
    ],
    { canPickMany: true, title: 'Apply patch: options', placeHolder: 'Press Enter to apply as is' },
  );
  if (!picks) return undefined;
  let strip = 0;
  if (picks.some((p) => p.id === 'strip')) {
    const v = await vscode.window.showInputBox({ prompt: 'How many leading path components to strip?', value: '1', validateInput: (s) => (/^\d{1,2}$/.test(s.trim()) ? undefined : 'Enter a number') });
    if (v === undefined) return undefined;
    strip = Number(v.trim());
  }
  return { reverse: picks.some((p) => p.id === 'reverse'), strip };
}

/** The affected file against its state after the patch, in the read-only compare view. */
async function previewEntry(ctx: CompareContext, cwd: string, files: FilePatch[], e: PatchOutcomeEntry, o: ApplyOptions): Promise<void> {
  const rel = e.path.replace(/\\/g, '/');
  const fp = files.find((f) => stripPath(f.path, o.strip) === rel);
  const abs = path.resolve(cwd, e.path);
  const name = path.basename(abs);
  if (!fp) {
    void vscode.window.showInformationMessage(`SVN: ${rel} is not a text patch (binary or property change); there is nothing to compare.`);
    return;
  }
  const exists = fs.existsSync(abs) && !isDir(abs);
  const current = exists ? fs.readFileSync(abs, 'utf8') : '';
  let after: string;
  try {
    const removes = o.reverse ? fp.isNew : fp.isDelete;
    after = removes ? '' : applyFilePatch(current, fp, { reverse: o.reverse });
  } catch (err) {
    void vscode.window.showWarningMessage(`SVN: ${rel}: ${(err as Error).message}. Those hunks would be rejected.`);
    return;
  }
  await openCompare(ctx, {
    left: { kind: 'text', text: current, name, label: exists ? 'Current file' : 'Current (does not exist)' },
    right: { kind: 'text', text: after, name, label: o.reverse ? 'After reversing the patch' : 'After the patch' },
    title: `${name} (patch preview)`,
  });
}

async function showRejects(rejects: string[]): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    rejects.map((r) => ({ label: path.basename(r), description: r, r })),
    { title: 'Rejected hunks (.svnpatch.rej)', placeHolder: 'Open a reject file' },
  );
  if (pick) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(pick.r), { preview: false });
}

async function applyFlow(services: Services, ctx: CompareContext, sel: Selection): Promise<void> {
  const { repo } = sel;
  let patchFile: string | undefined;
  let cwd = repo.localFolder;
  if (!sel.whole) {
    const p = sel.paths[0];
    if (sel.paths.length === 1 && fs.existsSync(p) && !isDir(p) && /\.(patch|diff)$/i.test(p)) patchFile = p;
    else if (isDir(p)) cwd = p;
    else cwd = path.dirname(p);
  }
  if (!patchFile) {
    const pick = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Apply Patch', title: `Patch file to apply in ${cwd}`, filters: { Patch: ['patch', 'diff'], 'All files': ['*'] } });
    if (!pick?.[0]) return;
    patchFile = pick[0].fsPath;
  }
  const opts = await pickApplyOptions();
  if (!opts) return;
  const base = { patchFile, reverse: opts.reverse, strip: opts.strip };
  const pc = (signal?: AbortSignal) => ({ client: services.client, repo, cwd, signal });

  const dry = await runOperation('Previewing patch (dry run)', (signal) => runPatch(pc(signal), { ...base, dryRun: true }));
  const parsed = parseUnifiedDiff(fs.readFileSync(patchFile, 'utf8'));
  const conflicted = new Set(dry.outcome.conflicts.map((c) => c.toLowerCase()));
  if (!dry.outcome.entries.length && !dry.outcome.skipped.length) {
    void vscode.window.showWarningMessage('SVN: The patch affects no files. Check the strip setting, or whether the file is a unified diff.');
    return;
  }
  type Item = vscode.QuickPickItem & { run?: boolean; entry?: PatchOutcomeEntry };
  for (;;) {
    const items: Item[] = [
      { label: `$(play) Apply${opts.reverse ? ' (reversed)' : ''} patch`, description: summarizeOutcome(dry.outcome), detail: dry.outcome.rejectedHunks ? `${dry.outcome.rejectedHunks} hunk(s) would be rejected and written to ${REJECT_SUFFIX} files.` : undefined, run: true },
      { label: 'Affected files (select one to compare it before and after)', kind: vscode.QuickPickItemKind.Separator },
      ...dry.outcome.entries.map((e) => ({
        label: `${e.action.padEnd(2)}  ${e.path}`,
        description: conflicted.has(e.path.toLowerCase()) ? 'conflict: some hunks rejected' : e.notes.some((n) => /offset/.test(n)) ? 'applies with offset' : e.notes.some((n) => /already applied/.test(n)) ? 'already applied' : undefined,
        entry: e,
      })),
      ...dry.outcome.skipped.map((s) => ({ label: `skipped  ${s}`, description: 'target does not exist' })),
    ];
    const pick = await vscode.window.showQuickPick(items, { title: `Preview: ${path.basename(patchFile)} in ${cwd}`, placeHolder: 'Nothing has been changed yet', ignoreFocusOut: true, matchOnDescription: true });
    if (!pick) return;
    if (pick.run) break;
    if (pick.entry) await previewEntry(ctx, cwd, parsed, pick.entry, opts);
  }

  const res = await withRepoLock(repo.name, () => runOperation('Applying patch', (signal) => runPatch(pc(signal), base)));
  if (!res) return;
  services.logger.info(`Patch applied: ${summarizeOutcome(res.outcome)}`);
  if (res.rejects.length) {
    const choice = await vscode.window.showWarningMessage(`SVN: Patch applied with rejected hunks (${summarizeOutcome(res.outcome)}).`, 'Show Rejects');
    if (choice) await showRejects(res.rejects);
  } else if (res.outcome.skipped.length) {
    await notifyWarning(services, `Patch applied (${summarizeOutcome(res.outcome)}).`);
  } else notifySuccess(services, `Patch applied: ${summarizeOutcome(res.outcome)}.`);
}

export function registerPatch(context: vscode.ExtensionContext, services: Services, compare: CompareContext): void {
  registerSelectionCommand(context, services, 'svnWorkflow.patch.create', (sel) => createPatchFlow(services, sel, { checklist: 'always', what: 'Create Patch' }));
  registerSelectionCommand(context, services, 'svnWorkflow.diff.exportUnified', (sel) => createPatchFlow(services, sel, { checklist: 'auto', what: 'Unified Diff' }));
  registerSelectionCommand(context, services, 'svnWorkflow.patch.apply', (sel) => applyFlow(services, compare, sel), { refreshAfter: true });
}

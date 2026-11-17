import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoEntry } from '../repos/model';
import type { Services } from '../services';
import { runOperation } from '../util/notify';
import { treeAdvice, type TreeOption, type VersionRef } from './model';
import { loadOneConflict, runTreeSteps } from './ops';
import { withRepoLockStrict } from '../util/repoCommand';
import { ctxFor, refreshRepo } from './sessions';

const GUIDE = '$(info) Explain this conflict and manual cleanup steps...';

function versionText(v: VersionRef | undefined): string {
  return v ? `^/${v.pathInRepos}${v.revision !== undefined ? '@' + v.revision : ''}` : '?';
}

/** Describes a tree conflict and offers the resolutions that make sense for its kind. Returns true when resolved. */
export async function resolveTreeConflict(services: Services, repo: RepoEntry, filePath: string): Promise<boolean> {
  const c = ctxFor(services, repo);
  const info = await loadOneConflict(c, filePath);
  const name = path.basename(filePath);
  if (!info?.tree) {
    void vscode.window.showInformationMessage(`SVN: "${name}" has no tree conflict.`);
    return false;
  }
  const advice = treeAdvice(info.tree);
  const isDir = info.nodeKind === 'dir' || info.tree.kind === 'dir';
  const explain = `${advice.summary}\n\nSource left: ${versionText(info.left)}\nSource right: ${versionText(info.right)}\n\n${advice.guidance.map((g) => `- ${g}`).join('\n')}`;

  for (;;) {
    type Item = vscode.QuickPickItem & { option?: TreeOption };
    const items: Item[] = [
      ...advice.options.map((o): Item => ({ label: o.label, detail: o.detail + (o.experimental ? ' (needs a matching move; svn may report it as inapplicable)' : '') + (o.destructive ? ' This discards local content.' : ''), option: o })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: GUIDE },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: `${name}: ${advice.summary}`, placeHolder: 'How do you want to resolve this tree conflict?', matchOnDetail: true, ignoreFocusOut: true });
    if (!pick) return false;
    if (!pick.option) {
      await vscode.window.showInformationMessage(`${name}: tree conflict`, { modal: true, detail: explain }, 'Back');
      continue;
    }
    const opt = pick.option;
    if (opt.destructive) {
      const ok = await vscode.window.showWarningMessage(`${opt.label}?`, { modal: true, detail: `${opt.detail}\n\n${name}\n${filePath}` }, 'Continue');
      if (ok !== 'Continue') continue;
    }
    await runOperation(`Resolving ${name}`, async () => {
      await withRepoLockStrict(repo.name, () => runTreeSteps(c, filePath, opt.steps, isDir));
    }).finally(() => refreshRepo(services, repo));
    void vscode.window.showInformationMessage(`SVN: ${name}: ${opt.label.replace(/\.$/, '')}. Done.`);
    return true;
  }
}

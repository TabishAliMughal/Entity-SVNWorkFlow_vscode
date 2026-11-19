import * as path from 'node:path';
import * as vscode from 'vscode';
import { ChangeItem } from '../incoming/model';
import { RepoEntry } from '../repos/model';
import { resolveTarget } from '../commands/target';
import { Services } from '../services';
import { reportError } from '../util/ui';
import { isChangelistNode } from '../changelist/nodes';
import { FolderNode, isItemNode, isRepoNode } from './nodes';

/** A command target regardless of where the command was invoked from. */
export interface SvnTarget {
  repo: RepoEntry;
  fsPath: string;
  /** Present when invoked from the SVN view, or when the path is a known changed item. */
  item?: ChangeItem;
  /** The target stands for the repo node of the SVN view (the whole scoped working copy). */
  wholeRepo?: boolean;
}

/**
 * Normalises the arguments VS Code passes to a command into targets:
 * - SVN view item (and multi-selection, passed as the 2nd argument)
 * - SVN view repo node: every item of that repo
 * - Explorer/editor Uri (or the active editor when called from the palette)
 */
export function collectTargets(services: Services, arg?: unknown, selection?: unknown): SvnTarget[] {
  if (isItemNode(arg) || isRepoNode(arg) || isChangelistNode(arg) || arg instanceof FolderNode) {
    const nodes = Array.isArray(selection) && selection.some((n) => n === arg) ? (selection as unknown[]) : [arg];
    const out: SvnTarget[] = [];
    for (const n of nodes) {
      if (isItemNode(n)) out.push({ repo: n.repo, fsPath: n.item.path, item: n.item });
      else if (isRepoNode(n)) out.push({ repo: n.repo, fsPath: services.incoming.scopeOf(n.repo)[0] ?? n.repo.localFolder, wholeRepo: true });
      else if (n instanceof FolderNode) out.push({ repo: n.repo, fsPath: n.path });
      else if (isChangelistNode(n)) for (const i of n.items) out.push({ repo: n.repo, fsPath: i.path, item: i });
    }
    return out;
  }
  const uris = Array.isArray(selection) && selection.every((s) => s instanceof vscode.Uri) && selection.length ? (selection as vscode.Uri[]) : [arg instanceof vscode.Uri ? arg : undefined];
  return uris.map((u) => {
    const t = resolveTarget(services, u);
    const item = services.incoming.getState(t.repo.name)?.items.find((i) => path.normalize(i.path).toLowerCase() === path.normalize(t.fsPath).toLowerCase());
    return { ...t, item };
  });
}

export interface SvnCommandOptions {
  /** Request a server re-check of the affected repos once the handler finishes (after update/commit/add...). Default false. */
  refreshAfter?: boolean;
}

/**
 * Registers a command usable from the SVN view (inline/context/title), the Explorer, the editor
 * and the palette. Errors go through reportError. Later tasks use this for every feature action.
 */
export function registerSvnCommand(
  context: vscode.ExtensionContext,
  services: Services,
  id: string,
  handler: (targets: SvnTarget[]) => unknown | Promise<unknown>,
  opts: SvnCommandOptions = {},
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(id, async (arg?: unknown, selection?: unknown) => {
      let repoNames: string[] = [];
      try {
        const targets = collectTargets(services, arg, selection);
        repoNames = [...new Set(targets.map((t) => t.repo.name))];
        await handler(targets);
      } catch (e) {
        await reportError(services, e, repoNames[0]);
      } finally {
        if (opts.refreshAfter) for (const repoName of repoNames) services.incoming.requestRefresh({ repoName, remote: true });
      }
    }),
  );
}

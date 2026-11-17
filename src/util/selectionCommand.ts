import * as vscode from 'vscode';
import { collectTargets } from '../pane/commands';
import { isRepoNode } from '../pane/nodes';
import type { RepoEntry } from '../repos/model';
import type { Services } from '../services';
import { pickRepo } from './repoCommand';
import { reportError } from './ui';

export interface Selection {
  repo: RepoEntry;
  /** Absolute files/folders the user picked (the working copy root for "everything"). */
  paths: string[];
  /** The whole working copy: invoked from the palette, the pane title or a repository node. */
  whole: boolean;
}

/**
 * Like registerSvnCommand but hands the handler the whole multi-selection of one repository. Called without
 * arguments (palette, view title) it asks for a repository and selects its entire working copy.
 */
export function registerSelectionCommand(
  context: vscode.ExtensionContext,
  services: Services,
  id: string,
  handler: (sel: Selection) => unknown | Promise<unknown>,
  opts: { refreshAfter?: boolean } = {},
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(id, async (arg?: unknown, selection?: unknown) => {
      let name: string | undefined;
      try {
        let sel: Selection;
        if (arg === undefined || (typeof arg === 'string' && services.repos.find(arg))) {
          const repo = typeof arg === 'string' ? services.repos.find(arg) : await pickRepo(services, 'Which repository (whole working copy)?');
          if (!repo) return;
          sel = { repo, paths: [repo.localFolder], whole: true };
        } else {
          const targets = collectTargets(services, arg, selection);
          if (!targets.length) return;
          const repos = new Set(targets.map((t) => t.repo.name));
          if (repos.size > 1) throw new Error('The selection spans several repositories. Select files of one repository.');
          sel = { repo: targets[0].repo, paths: [...new Set(targets.map((t) => t.fsPath))], whole: isRepoNode(arg) };
        }
        name = sel.repo.name;
        await handler(sel);
      } catch (e) {
        await reportError(services, e, name);
      } finally {
        if (opts.refreshAfter && name) services.incoming.requestRefresh({ repoName: name, remote: true });
      }
    }),
  );
}

import * as vscode from 'vscode';
import { registerChangelists } from '../changelist/register';
import { SvnTarget } from '../pane/commands';
import { RepoEntry } from '../repos/model';
import { Services } from '../services';
import { CommitDialog, targetsToRequest } from './dialog';

export interface CommitFeature {
  /** Plain Commit: dialog for the repos of the targets, the targets pre-checked. */
  commit(targets: SvnTarget[]): Promise<void>;
  /** Pane Commit All: asks which repos (if several have outgoing items), everything pre-checked. */
  commitAll(): Promise<void>;
  commitChangelist(repo: RepoEntry, changelist: string): Promise<void>;
}

/** Creates the commit dialog and registers the changelist commands that depend on it. */
export function createCommitFeature(context: vscode.ExtensionContext, services: Services): CommitFeature {
  const dialog = new CommitDialog(context, services);
  const feature: CommitFeature = {
    async commit(targets) {
      const req = targetsToRequest(targets);
      if (req) await dialog.open(req);
    },
    async commitAll() {
      const repos = services.incoming.visibleRepos();
      if (!repos.length) throw new Error('The opened folder is not inside a registered working copy.');
      const withChanges = repos.filter((r) => services.incoming.getState(r.name)?.items.some((i) => i.outgoing));
      if (!withChanges.length) {
        void vscode.window.showInformationMessage('SVN: no outgoing changes to commit.');
        return;
      }
      let chosen = withChanges;
      if (withChanges.length > 1) {
        const picks = await vscode.window.showQuickPick(
          withChanges.map((r) => ({ label: r.name, description: `${services.incoming.getState(r.name)?.items.filter((i) => i.outgoing).length} outgoing`, picked: true, repo: r })),
          { canPickMany: true, placeHolder: 'Commit changes of which repositories?' },
        );
        if (!picks?.length) return;
        chosen = picks.map((p) => p.repo);
      }
      await dialog.open({ repos: chosen, all: true });
    },
    async commitChangelist(repo, changelist) {
      await dialog.open({ repos: [repo], changelist });
    },
  };
  registerChangelists(context, services, (repo, name) => feature.commitChangelist(repo, name));
  return feature;
}

import * as vscode from 'vscode';
import { RepoEntry } from '../repos/model';
import { Services } from '../services';

export interface ResolvedTarget {
  repo: RepoEntry;
  /** Absolute filesystem path of the selected resource. */
  fsPath: string;
}

/**
 * Resolves the command target from an Explorer/editor-context Uri argument,
 * falling back to the active editor. Throws NoRepoError when outside every repo.
 */
export function resolveTarget(services: Services, uri?: vscode.Uri): ResolvedTarget {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target || target.scheme !== 'file') {
    throw new Error('Select a file or folder in the Explorer, or open a file, first.');
  }
  return { repo: services.resolver.require(target.fsPath), fsPath: target.fsPath };
}

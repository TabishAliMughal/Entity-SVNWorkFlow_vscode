import * as vscode from 'vscode';
import { addToList, removeFromList } from './model';

const KEY = 'svnWorkflow.localIgnoreList';

/** Per-workspace list of absolute paths, kept in workspaceState only: never svn:ignore, never committed. */
export class LocalIgnoreStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly memento: vscode.Memento) {}

  paths(): string[] {
    const v = this.memento.get<unknown>(KEY);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  }

  async add(paths: readonly string[]): Promise<void> {
    await this.set(addToList(this.paths(), paths));
  }

  async remove(paths: readonly string[]): Promise<void> {
    await this.set(removeFromList(this.paths(), paths));
  }

  private async set(list: string[]): Promise<void> {
    await this.memento.update(KEY, list);
    this.emitter.fire();
  }
}

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { openCompare, type CompareContext } from '../compare/panel';
import { mergeRevisionFromHistory } from '../merge/register';
import type { Source } from '../compare/sources';
import type { RepoEntry } from '../repos/model';
import type { LogEntry } from '../svn/xml';
import { notifySuccess, notifyWarning, runOperation } from '../util/notify';
import { reportError } from '../util/ui';
import { contentSecurityPolicy } from '../util/webviewHtml';
import { DEFAULT_PAGE_SIZE, LogFilter, loadPage, repoPathToUrl, validateFilter } from './model';
import { HistoryTarget, TargetInfo, logBatchFetcher, revertChangesOfRevision, revertToRevision, sidesForChange, targetInfo, updateToRevision } from './service';

export type FromWebview =
  | { type: 'ready' }
  | { type: 'load'; filter: LogFilter; more: boolean }
  | { type: 'diff'; rev: number; path: string }
  | { type: 'update' | 'revertChanges' | 'revertTo' | 'copy' | 'message' | 'merge'; rev: number };

const panels = new Map<string, HistoryPanel>();

export interface HistoryContext extends CompareContext {
  /** Called after a working-copy change so other views (blame, pane) refresh. */
  onWorkingCopyChanged?: (fsPath: string) => void;
}

export async function openHistory(ctx: HistoryContext, repo: RepoEntry, fsPath: string): Promise<void> {
  const key = `${repo.name}\u0000${fsPath.toLowerCase()}`;
  const existing = panels.get(key);
  if (existing) {
    existing.reveal();
    return;
  }
  const p = new HistoryPanel(ctx, repo, fsPath, key);
  panels.set(key, p);
}

class HistoryPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly entries = new Map<number, LogEntry>();
  private cursor: number | undefined;
  private filter: LogFilter = {};
  private ac?: AbortController;
  private info?: TargetInfo;
  private readonly t: HistoryTarget;
  private seq = 0;

  constructor(private readonly ctx: HistoryContext, private readonly repo: RepoEntry, private readonly fsPath: string, private readonly key: string) {
    this.t = { repoName: repo.name, fsPath, cwd: repo.localFolder };
    const root = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'history');
    this.panel = vscode.window.createWebviewPanel('svnWorkflow.history', `History: ${path.basename(fsPath) || repo.name}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [root],
    });
    this.panel.webview.html = this.html(root);
    this.panel.onDidDispose(() => {
      this.ac?.abort();
      panels.delete(this.key);
    });
    this.panel.webview.onDidReceiveMessage((m: FromWebview) => void this.onMessage(m));
  }

  /** History opened for a repository URL (repository browser): working-copy actions do not apply. */
  private get isUrl(): boolean {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(this.fsPath);
  }

  reveal(): void {
    this.panel.reveal();
  }

  private html(root: vscode.Uri): string {
    const w = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = w.asWebviewUri(vscode.Uri.joinPath(root, 'history.css'));
    const js = w.asWebviewUri(vscode.Uri.joinPath(root, 'history.js'));
    const csp = contentSecurityPolicy(w.cspSource, nonce);
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${css}"><title>SVN History</title></head><body><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private async onMessage(m: FromWebview): Promise<void> {
    try {
      // The webview is not trusted: act only on revisions that were sent to it.
      if (m.type !== 'ready' && m.type !== 'load' && (!Number.isInteger(m.rev) || !this.entries.has(m.rev))) {
        this.ctx.services.logger.warn(`History: ignored ${String(m.type)} for unknown revision ${String((m as { rev?: unknown }).rev)}`);
        return;
      }
      switch (m.type) {
        case 'ready':
          this.post({ type: 'init', name: this.fsPath, repo: this.repo.name, pageSize: DEFAULT_PAGE_SIZE, isUrl: this.isUrl });
          await this.load({}, false);
          break;
        case 'load':
          await this.load(m.filter, m.more);
          break;
        case 'diff':
          await this.openDiff(m.rev, m.path);
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(String(m.rev));
          void vscode.window.setStatusBarMessage(`Copied revision ${m.rev}`, 2500);
          break;
        case 'message':
          await this.showMessage(m.rev);
          break;
        case 'update':
        case 'revertChanges':
        case 'revertTo':
          if (this.isUrl) throw new Error('Update and revert need a working-copy path; this history is of a repository URL.');
          if (m.type === 'update') await this.update(m.rev);
          else await this.revert(m.rev, m.type === 'revertTo');
          break;
        case 'merge': {
          // For a URL the destination working copy is chosen in the merge dialog, starting from the repo root.
          const dest = this.isUrl ? this.repo.localFolder : this.fsPath;
          await mergeRevisionFromHistory({ services: this.ctx.services, compare: this.ctx }, this.repo, dest, (await this.getInfo()).url, m.rev);
          this.ctx.onWorkingCopyChanged?.(dest);
          break;
        }
      }
    } catch (e) {
      await reportError(this.ctx.services, e, this.repo.name);
    }
  }

  private async load(filter: LogFilter, more: boolean): Promise<void> {
    const bad = validateFilter(filter);
    if (bad) {
      this.post({ type: 'page', error: bad, entries: [], append: false, hasMore: false });
      return;
    }
    this.ac?.abort();
    const ac = (this.ac = new AbortController());
    const id = ++this.seq;
    if (!more) {
      this.filter = filter;
      this.cursor = undefined;
      this.entries.clear();
    }
    this.post({ type: 'loading', on: true });
    try {
      const page = await loadPage(logBatchFetcher(this.ctx.services.client, this.t, this.filter, ac.signal), this.filter, DEFAULT_PAGE_SIZE, more ? this.cursor : undefined);
      if (id !== this.seq) return;
      this.cursor = page.nextCursor;
      for (const e of page.entries) this.entries.set(e.revision, e);
      this.post({ type: 'page', entries: page.entries, append: more, hasMore: page.nextCursor !== undefined });
    } catch (e) {
      if (id !== this.seq || ac.signal.aborted) return;
      const msg = e instanceof Error ? e.message : String(e);
      this.post({ type: 'page', error: msg, entries: [], append: more, hasMore: false });
      await reportError(this.ctx.services, e, this.repo.name);
    }
  }

  private async getInfo(): Promise<TargetInfo> {
    this.info ??= await targetInfo(this.ctx.services.client, this.t);
    return this.info;
  }

  private async openDiff(rev: number, repoPath: string): Promise<void> {
    const entry = this.entries.get(rev);
    if (!entry) return;
    const lp = entry.paths.find((p) => p.path === repoPath);
    if (!lp || lp.kind === 'dir') return;
    const info = await this.getInfo();
    const s = sidesForChange(entry, repoPath);
    const name = path.posix.basename(repoPath);
    const side = (p: string | undefined, r: number | undefined, label: string): Source => {
      if (p === undefined || r === undefined) return { kind: 'text', text: '', name, label: `${label} (does not exist)` };
      // `url@rev` pins the peg revision so paths deleted or renamed since still resolve.
      return { kind: 'rev', repoName: this.repo.name, target: `${repoPathToUrl(info.root, p)}@${r}`, rev: r, label: `${label} r${r}` };
    };
    await openCompare(this.ctx, {
      left: side(s.leftPath, s.leftRev, 'Before'),
      right: side(s.rightPath, s.rightRev, 'After'),
      title: `${name} (r${s.leftRev ?? '-'} ↔ r${rev})`,
    });
  }

  private async showMessage(rev: number): Promise<void> {
    const e = this.entries.get(rev);
    if (!e) return;
    await vscode.window.showInformationMessage(`r${rev} by ${e.author ?? '?'} on ${(e.date ?? '').slice(0, 16).replace('T', ' ')}`, { modal: true, detail: e.message || '(no message)' });
  }

  private rel(): string {
    return path.relative(this.repo.localFolder, this.fsPath) || '.';
  }

  private async update(rev: number): Promise<void> {
    const ok = await vscode.window.showWarningMessage(
      `Update ${this.rel()} to revision ${rev}?`,
      { modal: true, detail: 'The working copy path is replaced with the content of that revision. Local changes are kept and merged where possible.' },
      'Update',
    );
    if (ok !== 'Update') return;
    const r = await runOperation(`Updating to r${rev}`, (signal) => updateToRevision(this.ctx.services.client, this.t, rev, signal));
    this.done(r.conflicts, `Updated ${this.rel()} to r${rev}`);
  }

  private async revert(rev: number, toRev: boolean): Promise<void> {
    const what = toRev
      ? `Revert ${this.rel()} to revision ${rev}?`
      : `Revert the changes made by revision ${rev} in ${this.rel()}?`;
    const detail = toRev
      ? `Undoes every change after r${rev} up to HEAD (reverse merge -r HEAD:${rev}) in your working copy. Nothing is committed; review and commit it yourself.`
      : `Reverse-merges r${rev} (merge -c -${rev}) into your working copy. Nothing is committed; review and commit it yourself.`;
    const label = 'Revert';
    const ok = await vscode.window.showWarningMessage(what, { modal: true, detail }, label);
    if (ok !== label) return;
    const r = await runOperation(`Reverting ${toRev ? `to r${rev}` : `r${rev}`}`, (signal) =>
      toRev ? revertToRevision(this.ctx.services.client, this.t, rev, signal) : revertChangesOfRevision(this.ctx.services.client, this.t, rev, signal),
    );
    this.done(r.conflicts, toRev ? `Reverted ${this.rel()} to r${rev} (uncommitted)` : `Reverted changes of r${rev} in ${this.rel()} (uncommitted)`);
  }

  private done(conflicts: string[], successMsg: string): void {
    this.ctx.services.incoming.requestRefresh({ repoName: this.repo.name, remote: true });
    this.ctx.onWorkingCopyChanged?.(this.fsPath);
    if (conflicts.length) {
      void notifyWarning(this.ctx.services, `${successMsg}, with ${conflicts.length} conflict(s): ${conflicts.slice(0, 5).join(', ')}${conflicts.length > 5 ? ', ...' : ''}`);
    } else {
      notifySuccess(this.ctx.services, successMsg);
    }
  }
}

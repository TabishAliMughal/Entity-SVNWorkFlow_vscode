import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { splitLines, type DiffOptions } from '../diff';
import type { Services } from '../services';
import { reportError } from '../util/ui';
import { contentSecurityPolicy } from '../util/webviewHtml';
import { buildResult, conflictText, merge3, type Choice, type Merge3 } from './merge';
import type { ConflictData, FromWebview, SideData, ToWebview } from './protocol';

export interface MergeInputs {
  base: string;
  mine: string;
  theirs: string;
  labels: { base: string; mine: string; theirs: string };
  encoding: string;
}

/** What a merge panel edits: svn text conflict, or the values of one conflicted property. */
export interface MergeSession {
  mode: 'text' | 'property';
  /** One panel per key. */
  key: string;
  title: string;
  name: string;
  lang?: string;
  notes?: string;
  applyLabel: string;
  resolveLabel: string;
  load(): Promise<MergeInputs>;
  /** Persist the merged text (file write / propset). */
  save(result: string): Promise<void>;
  /** Mark the conflict resolved in svn; runs after a save. */
  resolve(): Promise<boolean>;
  /** Opens the underlying file, if any. */
  open?(): Promise<void>;
}

export interface MergeContext {
  services: Services;
  extensionUri: vscode.Uri;
}

function defaultOptions(): Required<DiffOptions> {
  const c = vscode.workspace.getConfiguration('svnWorkflow.diff');
  const ws = c.get<string>('ignoreWhitespace', 'none');
  return {
    ignoreWhitespace: ws === 'trailing' || ws === 'all' ? ws : 'none',
    ignoreEol: c.get<boolean>('ignoreEol', false),
    ignoreCase: c.get<boolean>('ignoreCase', false),
  };
}

const panels = new Map<string, MergePanel>();

/** Opens (or reveals) the 3-way merge editor for a session. */
export async function openMergeEditor(ctx: MergeContext, session: MergeSession): Promise<void> {
  const existing = panels.get(session.key);
  if (existing) {
    existing.reveal();
    await existing.reload();
    return;
  }
  const p = new MergePanel(ctx, session);
  panels.set(session.key, p);
  await p.reload();
}

class MergePanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private inputs?: MergeInputs;
  private merge?: Merge3;
  private opts: Required<DiffOptions> = defaultOptions();
  private choices: Array<Choice | undefined> = [];
  private customs = new Map<number, string>();
  private version = 0;
  private ready = false;
  private saved = false;
  private resolved = false;
  private sent = { base: '', mine: '', theirs: '' };
  private sentOnce = false;

  constructor(private readonly ctx: MergeContext, private readonly session: MergeSession) {
    const { extensionUri } = ctx;
    this.panel = vscode.window.createWebviewPanel('svnWorkflow.conflict', session.title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'conflict'), vscode.Uri.joinPath(extensionUri, 'media', 'conflict'), vscode.Uri.joinPath(extensionUri, 'media', 'compare')],
    });
    this.panel.webview.html = this.html();
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((m: FromWebview) => void this.onMessage(m)),
    );
  }

  reveal(): void {
    this.panel.reveal(undefined, true);
  }

  private dispose(): void {
    panels.delete(this.session.key);
    for (const d of this.disposables) d.dispose();
  }

  private html(): string {
    const w = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (...p: string[]): vscode.Uri => w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, ...p));
    const csp = contentSecurityPolicy(w.cspSource, nonce);
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${uri('media', 'compare', 'compare.css')}"><link rel="stylesheet" href="${uri('media', 'conflict', 'conflict.css')}"><title>Resolve Conflict</title></head><body><div id="app"></div><script nonce="${nonce}" src="${uri('dist', 'conflict', 'webview.js')}"></script></body></html>`;
  }

  private post(m: ToWebview): void {
    if (this.ready) void this.panel.webview.postMessage(m);
  }

  async reload(): Promise<void> {
    this.post({ type: 'busy', busy: true });
    try {
      this.inputs = await this.session.load();
      this.sentOnce = false;
      this.saved = false;
      this.choices = [];
      this.customs.clear();
      this.recompute(false);
    } catch (e) {
      this.post({ type: 'notice', text: e instanceof Error ? e.message : String(e) });
      await reportError(this.ctx.services, e);
    } finally {
      this.post({ type: 'busy', busy: false });
    }
  }

  /** Re-merges with the current options; hand-made choices survive when the conflict count is unchanged. */
  private recompute(keepChoices: boolean): void {
    const i = this.inputs;
    if (!i) return;
    const next = merge3(i.base, i.mine, i.theirs, this.opts);
    if (!keepChoices || next.conflicts.length !== this.merge?.conflicts.length) {
      this.choices = new Array<Choice | undefined>(next.conflicts.length).fill(undefined);
      this.customs.clear();
    }
    this.merge = next;
    this.version++;
    this.send();
  }

  private side(which: 'base' | 'mine' | 'theirs'): SideData {
    const i = this.inputs as MergeInputs;
    const text = i[which];
    const d: SideData = { label: i.labels[which], lineCount: splitLines(text).length };
    if (!this.sentOnce || this.sent[which] !== text) {
      d.lines = splitLines(text).map((l) => l.text);
      this.sent[which] = text;
    }
    return d;
  }

  private result(): { text: string; unresolved: number } {
    return buildResult(this.merge as Merge3, this.choices, this.customs);
  }

  private send(): void {
    if (!this.ready || !this.inputs || !this.merge) return;
    const s = this.session;
    const msg: ConflictData = {
      type: 'data',
      version: this.version,
      mode: s.mode,
      name: s.name,
      lang: s.lang,
      notes: s.notes,
      encoding: this.inputs.encoding,
      mine: this.side('mine'),
      theirs: this.side('theirs'),
      base: this.side('base'),
      segments: this.merge.segments,
      choices: this.choices,
      customs: Object.fromEntries(this.customs),
      unresolved: this.merge.conflicts.filter((c) => !this.choices[c.index]).length,
      options: { ...this.opts },
      saved: this.saved,
      resolved: this.resolved,
      applyLabel: s.applyLabel,
      resolveLabel: s.resolveLabel,
    };
    this.sentOnce = true;
    this.post(msg);
  }

  private async onMessage(m: FromWebview): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          this.ready = true;
          this.sentOnce = false;
          this.send();
          break;
        case 'options':
          this.opts = { ignoreWhitespace: m.ignoreWhitespace, ignoreEol: m.ignoreEol, ignoreCase: m.ignoreCase };
          this.recompute(true);
          break;
        case 'choose':
          if (m.version !== this.version || !this.merge?.conflicts[m.conflict]) return this.send();
          this.choices[m.conflict] = m.choice;
          this.saved = false;
          this.version++;
          this.send();
          break;
        case 'edit': {
          const c = this.merge?.conflicts[m.conflict];
          if (m.version !== this.version || !this.merge || !c) return this.send();
          this.customs.set(c.index, conflictText(this.merge, c, this.choices[c.index], this.customs));
          this.choices[c.index] = 'custom';
          this.saved = false;
          this.version++;
          this.send();
          break;
        }
        case 'custom':
          // No re-render: the textarea in the webview already shows this text.
          if (m.version === this.version && this.merge?.conflicts[m.conflict]) {
            this.customs.set(m.conflict, m.text);
            this.saved = false;
          }
          break;
        case 'chooseAll':
          if (!this.merge) return;
          this.choices = this.choices.map((c) => c ?? m.choice);
          this.saved = false;
          this.version++;
          this.send();
          break;
        case 'save':
          await this.save(false);
          break;
        case 'saveResolve':
          await this.save(true);
          break;
        case 'openFile':
          await this.session.open?.();
          break;
        case 'refresh':
          await this.reload();
          break;
      }
    } catch (e) {
      await reportError(this.ctx.services, e);
    }
  }

  private async save(markResolved: boolean): Promise<void> {
    if (!this.merge) return;
    const r = this.result();
    if (r.unresolved) {
      void vscode.window.showWarningMessage(`${r.unresolved} conflict${r.unresolved === 1 ? '' : 's'} not resolved yet. Pick mine, theirs, both or edit each block first.`);
      return;
    }
    await this.session.save(r.text);
    this.saved = true;
    this.send();
    if (!markResolved) {
      const pick = await vscode.window.showInformationMessage(`SVN: saved ${this.session.name}. Mark it as resolved?`, 'Mark as Resolved');
      if (pick !== 'Mark as Resolved') return;
    }
    if (!(await this.session.resolve())) return;
    this.resolved = true;
    this.panel.dispose();
  }
}

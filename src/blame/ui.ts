import * as path from 'node:path';
import * as vscode from 'vscode';
import { Services } from '../services';
import { registerSvnCommand } from '../pane/commands';
import { notifyWarning } from '../util/notify';
import { BlameCache, DEFAULT_FORMAT, MappedBlame, formatAnnotation, mapBlameToText } from './model';
import { MessageCache, loadBlame } from './service';

const STATE_KEY = 'svnWorkflow.blameOn';

interface DocBlame {
  repoName: string;
  cwd: string;
  fsPath: string;
  mapped: MappedBlame;
}

export class BlameController implements vscode.Disposable {
  /** Documents whose gutter blame the user switched on. Per document, never persisted; closing the document switches it off. */
  private readonly enabled = new Set<string>();
  private readonly cache = new BlameCache();
  private readonly messages: MessageCache;
  private readonly docs = new Map<string, DocBlame>();
  private readonly deco = vscode.window.createTextEditorDecorationType({
    before: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 1.5em 0 0', fontStyle: 'normal' },
  });
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  private readonly subs: vscode.Disposable[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly failed = new Set<string>();
  constructor(_context: vscode.ExtensionContext, private readonly services: Services) {
    this.messages = new MessageCache(services.client);
    this.status.command = 'svnWorkflow.blame.toggle';
    this.status.text = '$(account) SVN Blame';
    this.status.tooltip = 'SVN blame annotations are on for this file. Click to turn off.';

    this.subs.push(
      vscode.window.onDidChangeVisibleTextEditors(() => void this.refreshAll()),
      vscode.window.onDidChangeActiveTextEditor(() => void this.syncUi()),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document, 250)),
      vscode.workspace.onDidSaveTextDocument((d) => this.schedule(d, 100)),
      vscode.workspace.onDidCloseTextDocument((d) => {
        this.docs.delete(d.uri.toString());
        this.enabled.delete(d.uri.toString());
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('svnWorkflow.blame')) void this.refreshAll();
      }),
      services.incoming.onDidChange(() => this.schedule(vscode.window.activeTextEditor?.document, 600)),
      vscode.languages.registerHoverProvider({ scheme: 'file' }, { provideHover: (d, p) => this.hover(d, p) }),
    );
    void this.syncUi();
  }

  /** Blame is on for the active editor's document. */
  isOn(): boolean {
    return this.isEnabled(vscode.window.activeTextEditor?.document);
  }

  isEnabled(doc: vscode.TextDocument | undefined): boolean {
    return !!doc && this.enabled.has(doc.uri.toString());
  }

  /** Toggles blame for one document (default: the active editor's); other files are not affected. */
  async toggle(doc = vscode.window.activeTextEditor?.document): Promise<void> {
    if (doc) await this.setFor(doc, !this.isEnabled(doc));
  }

  async setFor(doc: vscode.TextDocument, on: boolean): Promise<void> {
    if (on) this.enabled.add(doc.uri.toString());
    else this.enabled.delete(doc.uri.toString());
    await this.syncUi();
  }

  async refresh(): Promise<void> {
    await this.syncUi();
  }

  /** Drops cached blame (all, or one file); call after update/commit of those files. */
  invalidate(fsPath?: string): void {
    this.cache.invalidate(fsPath);
    if (fsPath) this.cache.invalidate(`${fsPath}\u0000w`);
  }

  private async syncUi(): Promise<void> {
    const on = this.isOn();
    await vscode.commands.executeCommand('setContext', STATE_KEY, on);
    if (on) this.status.show();
    else this.status.hide();
    await this.refreshAll();
  }

  private schedule(doc: vscode.TextDocument | undefined, ms: number): void {
    if (!doc || doc.uri.scheme !== 'file' || !this.isEnabled(doc)) return;
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        for (const ed of vscode.window.visibleTextEditors) if (ed.document === doc) void this.update(ed);
      }, ms),
    );
  }

  private async refreshAll(): Promise<void> {
    for (const ed of vscode.window.visibleTextEditors) {
      const key = ed.document.uri.toString();
      if (this.enabled.has(key)) continue;
      ed.setDecorations(this.deco, []);
      this.docs.delete(key);
    }
    await Promise.all(vscode.window.visibleTextEditors.map((ed) => this.update(ed)));
  }

  private async update(ed: vscode.TextEditor): Promise<void> {
    const doc = ed.document;
    if (!this.isEnabled(doc) || doc.uri.scheme !== 'file') return;
    const repo = this.services.resolver.resolve(doc.uri.fsPath);
    if (!repo) return;
    const key = doc.uri.toString();
    try {
      const ignoreWs = vscode.workspace.getConfiguration('svnWorkflow.blame').get<boolean>('ignoreWhitespace', false);
      const data = await loadBlame(this.services.client, this.cache, { repoName: repo.name, fsPath: doc.uri.fsPath, cwd: repo.localFolder }, { ignoreWhitespace: ignoreWs });
      const mapped = mapBlameToText(data.lines, data.baseText, doc.getText());
      this.docs.set(key, { repoName: repo.name, cwd: repo.localFolder, fsPath: doc.uri.fsPath, mapped });
      this.render(ed, mapped);
      this.failed.delete(key);
    } catch (e) {
      ed.setDecorations(this.deco, []);
      this.docs.delete(key);
      if (!this.failed.has(key)) {
        this.failed.add(key);
        const msg = e instanceof Error ? e.message.split(/\r?\n/)[0] : String(e);
        this.services.logger.warn(`blame unavailable for ${doc.uri.fsPath}: ${msg}`);
        void notifyWarning(this.services, `Blame unavailable for ${path.basename(doc.uri.fsPath)} (unversioned, added or binary?): ${msg}`);
      }
    }
  }

  private render(ed: vscode.TextEditor, mapped: MappedBlame): void {
    const fmt = vscode.workspace.getConfiguration('svnWorkflow.blame').get<string>('format', DEFAULT_FORMAT);
    // {message} is fetched lazily (hover only), so the gutter text drops it.
    const gutterFmt = fmt.replace(/\{message\}/g, '');
    const texts = mapped.map((m) => formatAnnotation(gutterFmt, m ? { author: m.author, revision: m.revision, date: m.date } : undefined));
    const width = texts.reduce((a, t) => Math.max(a, t.length), 0);
    const opts: vscode.DecorationOptions[] = [];
    const n = Math.min(mapped.length, ed.document.lineCount);
    for (let i = 0; i < n; i++) {
      opts.push({
        range: new vscode.Range(i, 0, i, 0),
        renderOptions: { before: { contentText: texts[i].padEnd(width, ' ').replace(/ /g, ' ') } },
      });
    }
    ed.setDecorations(this.deco, opts);
  }

  private async hover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    const d = this.docs.get(doc.uri.toString());
    if (!this.isEnabled(doc) || !d || pos.character !== 0) return undefined;
    const m = d.mapped[pos.line];
    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    if (!m || m.revision === undefined) {
      md.appendMarkdown('**Uncommitted change**  \nThis line differs from the BASE revision.');
    } else {
      const message = await this.messages.get(d.repoName, d.fsPath, m.revision, d.cwd);
      md.appendMarkdown(`**r${m.revision}** by `);
      md.appendText(m.author ?? '?');
      md.appendText(`  ${m.date ?? ''}`);
      md.appendMarkdown('\n\n');
      md.appendText(message ?? '(message unavailable)');
    }
    return new vscode.Hover(md, new vscode.Range(pos.line, 0, pos.line, 0));
  }

  dispose(): void {
    this.deco.dispose();
    this.status.dispose();
    for (const t of this.timers.values()) clearTimeout(t);
    for (const s of this.subs) s.dispose();
  }
}

export function registerBlame(context: vscode.ExtensionContext, services: Services): BlameController {
  const ctl = new BlameController(context, services);
  context.subscriptions.push(
    ctl,
    vscode.commands.registerCommand('svnWorkflow.blame.toggle', () => ctl.toggle()),
    vscode.commands.registerCommand('svnWorkflow.blame.refresh', async () => {
      ctl.invalidate();
      await ctl.refresh();
    }),
  );
  // Pane / Explorer / editor action: open the file and turn annotations on.
  registerSvnCommand(context, services, 'svnWorkflow.blame.show', async (targets) => {
    const t = targets[0];
    if (!t) return;
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(t.fsPath));
    const doc = vscode.window.activeTextEditor?.document;
    if (doc && doc.uri.fsPath.toLowerCase() === vscode.Uri.file(t.fsPath).fsPath.toLowerCase()) await ctl.setFor(doc, true);
  });
  return ctl;
}

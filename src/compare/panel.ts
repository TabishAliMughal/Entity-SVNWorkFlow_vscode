import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { diffLines, applyHunk, applyHunkReverse, splitLines, type DiffOptions, type DiffResult } from '../diff';
import * as path from 'node:path';
import { reportError } from '../util/ui';
import { pegSafe } from '../svn/client';
import { parseBlame, parseInfo } from '../svn/xml';
import { repoLocks } from '../override/commitLocks';
import { pathKey } from '../incoming/model';
import { parseUpdateConflicts } from '../ops/targets';
import { shouldAutoUpdate } from './uptodate';
import { classifyHunks, type HunkClass } from './classify';
import { compactBlame, type CompactBlame, type SideMeta } from './annotate';
import { contentSecurityPolicy } from '../util/webviewHtml';
import type { Services } from '../services';
import { decodeContent } from './content';
import { fetchContent, resolveCatTarget } from './fetch';
import { incomingUri } from './provider';
import { applyAllHunks, minimalEdit } from './pull';
import { EditHistory } from './history';
import type { Pos } from './editing';
import { languageFor } from './langs';
import type { DataMessage, FromWebview, SideInfo, ToWebview } from './protocol';
import { normalizeRequest, pickEditable, revLabel, sourceName, type CompareRequest, type Source } from './sources';
import { pickRevision } from './revisions';

interface SideState {
  src: Source;
  text: string;
  binary: boolean;
  missing: boolean;
  encoding: string;
  doc?: vscode.TextDocument;
  /** Text last sent to the webview. */
  sent?: string;
  meta?: SideMeta;
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

const BINARY_NOTICE = 'Binary file: no text diff is shown.';
const panels = new Map<string, ComparePanel>();
/** Panels that follow a `reuseKey` (the pane's single compare tab). */
const reusable = new Map<string, ComparePanel>();

export interface CompareContext {
  services: Services;
  extensionUri: vscode.Uri;
}

/** Opens (or reveals) the compare view. Reusable entry point for every diff in the extension. */
export async function openCompare(ctx: CompareContext, request: CompareRequest): Promise<void> {
  const req = normalizeRequest(request);
  const key = JSON.stringify([req.left, req.right]);
  const existing = panels.get(key);
  if (existing) {
    existing.reveal();
    await existing.reload();
    return;
  }
  const shared = req.reuseKey ? reusable.get(req.reuseKey) : undefined;
  if (shared) {
    shared.reveal();
    await shared.retarget(req, key);
    return;
  }
  const p = new ComparePanel(ctx, req, key);
  panels.set(key, p);
  if (req.reuseKey) {
    p.reuseKey = req.reuseKey;
    reusable.set(req.reuseKey, p);
  }
  await p.reload();
}

class ComparePanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private sides: { left: SideState; right: SideState };
  private opts: Required<DiffOptions> = defaultOptions();
  private diff?: DiffResult;
  private notice?: string;
  private version = 0;
  private ready = false;
  private timer?: NodeJS.Timeout;
  private src: { left: Source; right: Source };
  private readonly history = new EditHistory();
  private queue: Promise<void> = Promise.resolve();
  private ackSeq = 0;
  private pendingCaret?: Pos;
  /** Document version right after our last own edit; a different version means someone else edited and our history is stale. */
  private ownVersion = -1;

  reuseKey?: string;
  private readonly metaCache = new Map<string, Promise<SideMeta | undefined>>();
  private readonly blameCache = new Map<string, Promise<CompactBlame | undefined>>();
  private upToDate?: string;
  private updating = false;
  /** BASE text of the local file: the common ancestor for classifying hunks (local vs server). */
  private baseText?: string;
  private classes?: HunkClass[];

  constructor(private readonly ctx: CompareContext, private req: CompareRequest, private key: string) {
    this.src = { left: req.left, right: req.right };
    this.sides = { left: this.emptySide(req.left), right: this.emptySide(req.right) };
    const { extensionUri } = ctx;
    this.panel = vscode.window.createWebviewPanel(
      'svnWorkflow.compare',
      req.title ?? `${sourceName(req.left)}: compare`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'compare'), vscode.Uri.joinPath(extensionUri, 'media', 'compare')] },
    );
    this.panel.webview.html = this.html();
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((m: FromWebview) => void this.onMessage(m)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.localDocs().includes(e.document)) this.scheduleRefresh();
      }),
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (this.localDocs().includes(d)) this.scheduleRefresh();
      }),
      vscode.workspace.onDidCloseTextDocument((d) => {
        if (this.localDocs().includes(d)) this.scheduleRefresh();
      }),
    );
  }

  reveal(): void {
    this.panel.reveal(undefined, true);
  }

  /** Shows another file in this panel (the pane's single compare tab). Unsaved edits stay in the document (dirty). */
  async retarget(req: CompareRequest, key: string): Promise<void> {
    panels.delete(this.key);
    this.key = key;
    panels.set(key, this);
    this.req = req;
    this.src = { left: req.left, right: req.right };
    this.sides = { left: this.emptySide(req.left), right: this.emptySide(req.right) };
    this.history.clear();
    this.upToDate = undefined;
    this.pendingCaret = { line: 0, col: 0 };
    this.panel.title = req.title ?? `${sourceName(req.left)}: compare`;
    await this.reload();
  }

  private dispose(): void {
    panels.delete(this.key);
    if (this.reuseKey && reusable.get(this.reuseKey) === this) reusable.delete(this.reuseKey);
    clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }

  private localDocs(): vscode.TextDocument[] {
    return [this.sides.left.doc, this.sides.right.doc].filter((d): d is vscode.TextDocument => !!d);
  }

  private html(): string {
    const w = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const script = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'compare', 'webview.js'));
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'compare', 'compare.css'));
    const csp = contentSecurityPolicy(w.cspSource, nonce);
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${css}"><title>Compare</title></head><body><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }

  private post(m: ToWebview): void {
    if (this.ready) void this.panel.webview.postMessage(m);
  }

  private scheduleRefresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.recompute(true).catch((e) => reportError(this.ctx.services, e)), 150);
  }

  /** Re-reads both sides (svn cat for revision sources) and re-diffs. */
  async reload(): Promise<void> {
    this.post({ type: 'busy', busy: true });
    this.metaCache.clear();
    this.blameCache.clear();
    try {
      const [left, right] = await Promise.all([this.loadSide(this.src.left), this.loadSide(this.src.right)]);
      await Promise.all([this.loadMeta(left), this.loadMeta(right)]);
      this.baseText = await this.loadBase(left, right);
      this.sides = { left, right };
      await this.recompute(false);
    } catch (e) {
      this.notice = e instanceof Error ? e.message : String(e);
      this.diff = undefined;
      this.version++;
      this.send();
      await reportError(this.ctx.services, e);
    } finally {
      this.post({ type: 'busy', busy: false });
    }
  }

  private emptySide(src: Source): SideState {
    return { src, text: '', binary: false, missing: false, encoding: 'utf-8' };
  }

  private async loadSide(src: Source): Promise<SideState> {
    if (src.kind === 'text') return { src, text: src.text, binary: false, missing: false, encoding: 'utf-8' };
    if (src.kind === 'rev') {
      const target = await this.catTarget(src.repoName, src.target);
      const f = await fetchContent(this.ctx.services.client, { repoName: src.repoName, target, rev: src.rev });
      return { src, text: f.text, binary: f.binary, missing: f.missing, encoding: f.encoding };
    }
    const uri = vscode.Uri.file(src.fsPath);
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      return { src, text: '', binary: false, missing: true, encoding: 'utf-8' };
    }
    const dec = decodeContent(bytes);
    if (dec.binary) return { src, text: '', binary: true, missing: false, encoding: dec.encoding };
    const doc = await vscode.workspace.openTextDocument(uri);
    return { src, text: doc.getText(), binary: false, missing: false, encoding: dec.encoding, doc };
  }

  /** Last commit of a revision source (`svn info -r`), cached; failures just mean no author in the header. */
  private async loadMeta(side: SideState): Promise<void> {
    const src = side.src;
    if (src.kind !== 'rev' || side.missing) return;
    const key = `${src.target}|${src.rev}`;
    let p = this.metaCache.get(key);
    if (!p) {
      p = this.catTarget(src.repoName, src.target)
        .then((t) => this.ctx.services.client.run(['info', '-r', String(src.rev), '--', pegSafe(t)], { repoName: src.repoName, xml: true }))
        .then((r) => {
          const i = parseInfo(r.text);
          return { author: i.lastChangedAuthor, revision: i.lastChangedRevision, date: i.lastChangedDate } as SideMeta;
        })
        .catch(() => undefined);
      this.metaCache.set(key, p);
    }
    side.meta = await p;
  }

  /** BASE of the local file, only when a local file is compared with a server revision (otherwise no 3-way classes). */
  private async loadBase(left: SideState, right: SideState): Promise<string | undefined> {
    const l = left.src;
    const r = right.src;
    if (l.kind !== 'local' || !l.repoName || r.kind !== 'rev' || r.rev === 'BASE' || left.missing || left.binary || right.binary) return undefined;
    try {
      const f = await fetchContent(this.ctx.services.client, { repoName: l.repoName, target: l.fsPath, rev: 'BASE' });
      return f.missing || f.binary ? undefined : f.text;
    } catch {
      return undefined;
    }
  }

  /** Blame of a revision source, sent after the data message; the view maps it onto the changed hunks. */
  private async sendBlame(which: 'left' | 'right'): Promise<void> {
    const side = this.sides[which];
    const src = side.src;
    if (src.kind !== 'rev' || side.missing || side.binary) return;
    const text = side.text;
    const key = `${src.target}|${src.rev}`;
    let p = this.blameCache.get(key);
    if (!p) {
      p = this.catTarget(src.repoName, src.target)
        .then((t) => this.ctx.services.client.run(['blame', '-r', String(src.rev), '--', pegSafe(t)], { repoName: src.repoName, xml: true }))
        .then((r) => compactBlame(parseBlame(r.text), splitLines(text).length))
        .catch(() => undefined);
      this.blameCache.set(key, p);
    }
    const blame = await p;
    if (blame && this.sides[which].text === text) this.post({ type: 'blame', side: which, blame });
  }

  private async catTarget(repoName: string, target: string): Promise<string> {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return target;
    return resolveCatTarget(this.ctx.services.client, repoName, target);
  }

  /** Re-diffs the current text; `fromDoc` first re-reads the local sides (live update). */
  private async recompute(fromDoc: boolean): Promise<void> {
    if (fromDoc) {
      for (const side of [this.sides.left, this.sides.right]) {
        if (side.src.kind !== 'local') continue;
        if (side.doc && !side.doc.isClosed) side.text = side.doc.getText();
        else Object.assign(side, await this.loadSide(side.src));
      }
    }
    const { left, right } = this.sides;
    this.version++;
    this.notice = undefined;
    if (left.binary || right.binary) {
      this.diff = undefined;
      this.notice = BINARY_NOTICE;
    } else {
      this.diff = diffLines(left.text, right.text, this.opts);
      if (left.text !== right.text) this.upToDate = undefined;
      this.classes = this.baseText === undefined ? undefined : classifyHunks(this.baseText, left.text, right.text, this.diff.hunks, this.opts);
    }
    this.send();
    void this.autoUpdate().catch((e) => reportError(this.ctx.services, e));
  }

  /**
   * Local text equals the incoming (HEAD) text exactly and the file is still listed as incoming:
   * `svn update` that file so it leaves the list (identical local edits merge clean). Conflicts are surfaced, not resolved.
   */
  private async autoUpdate(): Promise<void> {
    const { left, right } = this.sides;
    const l = left.src;
    const r = right.src;
    if (this.updating || l.kind !== 'local' || r.kind !== 'rev' || !left.doc || left.doc.isClosed || left.missing || right.missing || left.binary || right.binary) return;
    const { services } = this.ctx;
    const listed = !!services.incoming.getState(r.repoName)?.items.some((i) => i.incoming && pathKey(i.path) === pathKey(l.fsPath));
    if (!shouldAutoUpdate({ leftIsLocal: true, rightIsHead: r.rev === 'HEAD', leftText: left.text, docText: left.doc.getText(), rightText: right.text, listedIncoming: listed })) return;
    const release = repoLocks.tryAcquire(r.repoName);
    if (!release) return;
    this.updating = true;
    try {
      if (left.doc.isDirty && !(await left.doc.save())) return;
      const res = await services.client.run(['update', '--accept', 'postpone', '--', pegSafe(l.fsPath)], { repoName: r.repoName });
      const conflicts = parseUpdateConflicts(res.text);
      if (conflicts.length) {
        void vscode.window.showWarningMessage(`SVN: updating ${path.basename(l.fsPath)} reported a conflict: ${conflicts.join(', ')}. Resolve it before committing.`);
        return;
      }
      this.upToDate = 'Up to date: local equals the incoming version and svn update was applied.';
    } finally {
      this.updating = false;
      release();
    }
    await services.incoming.refresh({ repoName: r.repoName, remote: true });
    await this.recompute(true);
  }

  private info(side: SideState): SideInfo {
    const src = side.src;
    const label = src.label ?? (src.kind === 'local' ? 'Local (working copy)' : src.kind === 'rev' ? revLabel(src.rev) : sourceName(src));
    const info: SideInfo = {
      name: sourceName(src),
      label: side.missing ? `${label} (does not exist)` : label,
      lang: languageFor(sourceName(src)),
      lineCount: splitLines(side.text).length,
      missing: side.missing,
      encoding: side.encoding,
      openable: src.kind !== 'text' && !side.missing,
      isBase: src.kind === 'rev' && src.rev === 'BASE',
      meta: side.meta,
      endsWithEol: side.text === '' || /[\r\n]$/.test(side.text),
      dirty: !!side.doc?.isDirty,
    };
    if (side.sent !== side.text) {
      info.lines = splitLines(side.text).map((l) => l.text);
      side.sent = side.text;
    }
    return info;
  }

  private send(): void {
    if (!this.ready) return;
    const d = this.diff;
    const msg: DataMessage = {
      type: 'data',
      version: this.version,
      notice: this.notice,
      left: this.info(this.sides.left),
      right: this.info(this.sides.right),
      blocks: d?.blocks ?? [],
      hunks: d?.hunks ?? [],
      classes: this.classes,
      identical: d?.identical ?? false,
      editable: this.notice ? null : pickEditable(this.req),
      upToDate: d?.identical && this.sides.left.text === this.sides.right.text ? this.upToDate : undefined,
      options: { ...this.opts },
      canPickRevision: [this.src.left, this.src.right].some((s) => s.kind === 'rev' && s.rev !== 'BASE'),
      typing: this.canType(),
      ackSeq: this.ackSeq,
      caret: this.pendingCaret,
    };
    this.pendingCaret = undefined;
    this.post(msg);
    for (const w of ['left', 'right'] as const) if (msg[w].lines) void this.sendBlame(w);
  }

  private async onMessage(m: FromWebview): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          this.ready = true;
          this.sides.left.sent = this.sides.right.sent = undefined;
          this.send();
          break;
        case 'options':
          this.opts = { ignoreWhitespace: m.ignoreWhitespace, ignoreEol: m.ignoreEol, ignoreCase: m.ignoreCase };
          await this.recompute(false);
          break;
        case 'pull':
          await this.enqueue(() => this.pull(m.version, m.hunk));
          break;
        case 'pullAll':
          await this.enqueue(() => this.pull(m.version, undefined));
          break;
        case 'edit':
          await this.enqueue(() => this.userEdit(m.seq, m.start, m.end, m.text));
          break;
        case 'undo':
        case 'redo':
          await this.enqueue(() => this.undoRedo(m.seq, m.type === 'undo'));
          break;
        case 'save':
          await this.editDoc()?.save();
          this.scheduleRefresh();
          break;
        case 'openAt':
          await this.openAt(m.side, m.line);
          break;
        case 'pickRevision':
          await this.changeRevision();
          break;
        case 'refresh':
          await this.reload();
          break;
      }
    } catch (e) {
      await reportError(this.ctx.services, e);
    }
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn).catch((e) => reportError(this.ctx.services, e));
    return this.queue;
  }

  private editSide(): SideState | undefined {
    const e = this.notice ? null : pickEditable(this.req);
    return e ? this.sides[e] : undefined;
  }

  private editDoc(): vscode.TextDocument | undefined {
    const d = this.editSide()?.doc;
    return d && !d.isClosed ? d : undefined;
  }

  private canType(): boolean {
    const s = this.editSide();
    return !!s && s.src.kind === 'local' && !s.missing && !!this.editDoc();
  }

  /** Replaces a document range through a WorkspaceEdit (undoable, leaves the file dirty). */
  private async replaceRange(doc: vscode.TextDocument, range: vscode.Range, text: string): Promise<boolean> {
    const we = new vscode.WorkspaceEdit();
    we.replace(doc.uri, range, text);
    const ok = await vscode.workspace.applyEdit(we);
    if (ok) this.ownVersion = doc.version;
    return ok;
  }

  private async userEdit(seq: number, start: Pos, end: Pos, text: string): Promise<void> {
    const side = this.editSide();
    const doc = this.editDoc();
    try {
      if (!side || !doc || !this.canType()) return;
      const range = doc.validateRange(new vscode.Range(start.line, start.col, end.line, end.col));
      const removed = doc.getText(range);
      if (removed === '' && text === '') return;
      const from = { line: range.start.line, col: range.start.character };
      const stale = doc.version !== this.ownVersion;
      if (await this.replaceRange(doc, range, text)) {
        if (stale) this.history.clear();
        this.history.record({ start: from, removed, inserted: text, time: Date.now() });
      }
    } finally {
      this.ackSeq = seq;
      if (side) side.sent = undefined;
      this.scheduleRefresh();
    }
  }

  private async undoRedo(seq: number, undo: boolean): Promise<void> {
    const side = this.editSide();
    const doc = this.editDoc();
    try {
      if (!side || !doc) return;
      if (doc.version !== this.ownVersion) this.history.clear();
      const step = undo ? this.history.undo() : this.history.redo();
      if (!step) return;
      const range = doc.validateRange(new vscode.Range(step.start.line, step.start.col, step.end.line, step.end.col));
      if (await this.replaceRange(doc, range, step.text)) this.pendingCaret = step.caret;
      else this.history.clear();
    } finally {
      this.ackSeq = seq;
      clearTimeout(this.timer);
      await this.recompute(true);
    }
  }

  /** Pull one hunk (or all when `hunk` is undefined) into the editable side through a WorkspaceEdit: undoable, left dirty. */
  private async pull(version: number, hunk: number | undefined): Promise<void> {
    const editable = pickEditable(this.req);
    if (!editable || !this.diff) return;
    if (version !== this.version) {
      this.send();
      return;
    }
    const target = this.sides[editable];
    const source = this.sides[editable === 'left' ? 'right' : 'left'];
    const src = target.src;
    if (src.kind !== 'local') return;
    if (target.doc && target.doc.getText() !== target.text) {
      await this.recompute(true);
      void vscode.window.showInformationMessage('The file changed while the view was open; review the refreshed diff and pull again.');
      return;
    }
    const d = this.diff;
    let next: string;
    if (hunk === undefined) {
      next = applyAllHunks(target.text, source.text, d, editable === 'left' ? 'local' : 'incoming', this.opts);
    } else {
      const h = d.hunks[hunk];
      if (!h) return;
      const { left, right } = this.sides;
      next = editable === 'left' ? applyHunk(left.text, right.text, h, this.opts) : applyHunkReverse(left.text, right.text, h, this.opts);
    }
    const edit = minimalEdit(target.text, next);
    if (!edit) return;
    const uri = vscode.Uri.file(src.fsPath);
    const we = new vscode.WorkspaceEdit();
    const doc = target.doc;
    if (target.missing || !doc) {
      we.createFile(uri, { ignoreIfExists: true });
      we.insert(uri, new vscode.Position(0, 0), next);
    } else {
      we.replace(uri, new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end)), edit.text);
    }
    const before = doc && !target.missing ? { start: doc.positionAt(edit.start), removed: target.text.slice(edit.start, edit.end) } : undefined;
    if (!(await vscode.workspace.applyEdit(we))) {
      void vscode.window.showErrorMessage('Could not apply the change to the local file.');
      return;
    }
    if (doc && before) {
      this.ownVersion = doc.version;
      this.history.record({ start: { line: before.start.line, col: before.start.character }, removed: before.removed, inserted: edit.text, time: Date.now() });
    }
    clearTimeout(this.timer);
    if (!doc) Object.assign(target, await this.loadSide(src));
    await this.recompute(true);
  }

  private async openAt(side: 'left' | 'right', line: number): Promise<void> {
    const s = this.sides[side];
    if (s.missing) return;
    const src = s.src;
    let uri: vscode.Uri;
    if (src.kind === 'local') uri = vscode.Uri.file(src.fsPath);
    else if (src.kind === 'rev') uri = incomingUri(src.repoName, await this.catTarget(src.repoName, src.target), src.rev);
    else return;
    const doc = await vscode.workspace.openTextDocument(uri);
    const pos = new vscode.Position(Math.max(0, Math.min(line, doc.lineCount - 1)), 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: false, viewColumn: vscode.ViewColumn.Active });
  }

  private async changeRevision(): Promise<void> {
    const which = (['right', 'left'] as const).find((w) => {
      const s = this.src[w];
      return s.kind === 'rev' && s.rev !== 'BASE';
    });
    const s = which && this.src[which];
    if (!which || !s || s.kind !== 'rev') return;
    const rev = await pickRevision(this.ctx.services, s.repoName, await this.catTarget(s.repoName, s.target));
    if (rev === undefined) return;
    this.src[which] = { ...s, rev, label: undefined };
    await this.reload();
  }
}

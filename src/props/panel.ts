import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { updatePaths } from '../ops/svnOps';
import { RepoEntry } from '../repos/model';
import { Services } from '../services';
import { SvnError } from '../svn/errors';
import { notifySuccess, runOperation } from '../util/notify';
import { reportError } from '../util/ui';
import { webviewHtml } from '../util/webviewHtml';
import { ExternalDef, formatExternals, parseExternals, validateExternal } from './externals';
import { EOL_STYLES, KEYWORDS, PropChange, normalizeLines, propAppliesTo } from './model';
import { applyChanges, listProps } from './ops';
import { withRepoLockStrict } from '../util/repoCommand';

const COMMON = ['svn:ignore', 'svn:global-ignores', 'svn:externals', 'svn:keywords', 'svn:eol-style', 'svn:mime-type', 'svn:executable', 'svn:needs-lock'];

const BODY = `<h2 id="title">Properties</h2>
<div class="sub" id="sub"></div>
<div id="cards"></div>
<div class="empty" id="empty">No properties set.</div>
<div class="add">
  <input type="text" id="newName" list="names" placeholder="Property name (svn:ignore, svn:externals, custom...)">
  <datalist id="names"></datalist>
  <button id="addBtn">Add property</button>
</div>
<div class="bar">
  <label id="recursiveBar"><input type="checkbox" id="recursive"> Apply changes recursively to everything inside this folder</label>
  <span class="spacer"></span>
  <button id="reload">Reload</button>
  <button class="primary" id="save">Save</button>
</div>
<div class="error" id="error"></div>`;

type WebChange = { name: string; text?: string; lines?: boolean; externals?: ExternalDef[] };

function toPropChanges(changes: WebChange[], recursive: boolean, other: readonly string[]): PropChange[] {
  return changes.map((c) => {
    if (c.externals) {
      const bad = c.externals.map((d, i) => validateExternal(d).map((e) => `Row ${i + 1}: ${e}`)).flat();
      if (bad.length) throw new Error(`svn:externals:\n${bad.join('\n')}`);
      return { name: c.name, value: c.externals.length || other.length ? formatExternals(c.externals, other) : undefined };
    }
    if (c.text === undefined) return { name: c.name, recursive };
    const value = c.lines ? normalizeLines(c.text) : c.name === 'svn:keywords' || c.name === 'svn:eol-style' || c.name === 'svn:mime-type' ? c.text.trim() : c.text;
    return { name: c.name, value, recursive };
  });
}

export class PropertiesPanel {
  private static readonly open = new Map<string, PropertiesPanel>();
  private readonly panel: vscode.WebviewPanel;
  private other: string[] = [];
  private ready = false;

  static show(context: vscode.ExtensionContext, services: Services, repo: RepoEntry, target: string): void {
    const key = target.toLowerCase();
    const existing = PropertiesPanel.open.get(key);
    if (existing) {
      existing.panel.reveal();
      if (existing.ready) void existing.sendInit();
      return;
    }
    PropertiesPanel.open.set(key, new PropertiesPanel(context, services, repo, target, key));
  }

  private constructor(private readonly context: vscode.ExtensionContext, private readonly services: Services, private readonly repo: RepoEntry, private readonly target: string, key: string) {
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media', 'props');
    this.panel = vscode.window.createWebviewPanel('svnWorkflow.props', `Properties: ${path.basename(target)}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot],
    });
    const web = this.panel.webview;
    web.html = webviewHtml({
      cspSource: web.cspSource,
      nonce: crypto.randomBytes(16).toString('base64'),
      title: 'SVN Properties',
      scriptUri: web.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'props.js')).toString(),
      styleUri: web.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'props.css')).toString(),
      body: BODY,
    });
    this.panel.onDidDispose(() => PropertiesPanel.open.delete(key));
    web.onDidReceiveMessage((m: { type: string; changes?: WebChange[]; recursive?: boolean }) => {
      void this.onMessage(m).catch(async (e) => {
        void this.panel.webview.postMessage({ type: 'error', text: e instanceof Error ? e.message : String(e) });
        await reportError(this.services, e, this.repo.name);
      });
    });
  }

  private isDir(): boolean {
    try {
      return fs.statSync(this.target).isDirectory();
    } catch {
      return false;
    }
  }

  private ctx(signal?: AbortSignal) {
    return { client: this.services.client, repo: this.repo, signal };
  }

  private async sendInit(error?: string): Promise<void> {
    const isDir = this.isDir();
    const props = await listProps(this.ctx(), this.target);
    const ext = parseExternals(props.find((p) => p.name === 'svn:externals')?.value ?? '');
    this.other = ext.other;
    await this.panel.webview.postMessage({
      type: 'init',
      path: this.target,
      rel: path.relative(this.repo.localFolder, this.target).split(path.sep).join('/') || this.repo.name,
      isDir,
      props,
      externals: ext,
      keywords: KEYWORDS,
      eolStyles: EOL_STYLES,
      suggest: COMMON.filter((n) => propAppliesTo(n, isDir)),
      error,
    });
  }

  private async onMessage(m: { type: string; changes?: WebChange[]; recursive?: boolean }): Promise<void> {
    if (m.type === 'ready') {
      this.ready = true;
      await this.sendInit();
    } else if (m.type === 'reload') {
      await this.sendInit();
    } else if (m.type === 'save' && m.changes) {
      const isDir = this.isDir();
      const changes = toPropChanges(m.changes, !!m.recursive && isDir, this.other);
      const tmpDir = path.join(this.context.globalStorageUri.fsPath, 'tmp');
      let names: string[];
      try {
        names = await withRepoLockStrict(this.repo.name, () => runOperation('Saving properties', (signal) => applyChanges(this.ctx(signal), this.target, isDir, changes, tmpDir)));
      } finally {
        this.services.incoming.requestRefresh({ repoName: this.repo.name, remote: true });
      }
      notifySuccess(this.services, `Properties saved on ${path.basename(this.target)}: ${names.join(', ')}.`);
      await this.sendInit();
      if (names.includes('svn:externals')) await this.offerExternalsUpdate();
    }
  }

  private async offerExternalsUpdate(): Promise<void> {
    const pick = await vscode.window.showInformationMessage('SVN: svn:externals changed. Update now to fetch the externals?', 'Update', 'Later');
    if (pick !== 'Update') return;
    try {
      await runOperation('Updating externals', (signal) => updatePaths(this.ctx(signal), [this.target]));
      notifySuccess(this.services, 'Externals updated.');
    } catch (e) {
      if (e instanceof SvnError && e.kind === 'cancelled') return;
      await reportError(this.services, e, this.repo.name);
    } finally {
      await this.services.incoming.refresh({ repoName: this.repo.name, remote: true });
    }
  }
}

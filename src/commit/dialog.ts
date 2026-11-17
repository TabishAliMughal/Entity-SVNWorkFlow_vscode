import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { openCompare } from '../compare/commands';
import { incomingUri } from '../compare/provider';
import { ChangeItem, isSameOrUnder, pathKey } from '../incoming/model';
import { repoLocks } from '../override/commitLocks';
import { updatePaths } from '../ops/svnOps';
import { SvnTarget } from '../pane/commands';
import { RepoEntry } from '../repos/model';
import { CONFIG_SECTION, Services } from '../services';
import { SvnError } from '../svn/errors';
import { notifySuccess, runOperation } from '../util/notify';
import { confirmBulk, reportError } from '../util/ui';
import { webviewHtml } from '../util/webviewHtml';
import { commitChangelist, executeCommit } from './execute';
import { CommitEntry, CommitPlan, blockedReason, buildPlan, defaultChecked, entryKind, isOutOfDate, pushHistory, sanitizeHistory, validateCommit } from './selection';

const HISTORY_KEY = 'svnWorkflow.commitMessages';

const BODY = `<h2 id="title">Commit</h2>
<div class="toolbar">
  <button class="secondary" id="checkAll">Check all</button>
  <button class="secondary" id="uncheckAll">Uncheck all</button>
  <button class="secondary" id="refresh">Refresh</button>
  <span class="spacer"></span>
  <span class="status" id="count"></span>
</div>
<div class="files" id="files"></div>
<div class="msg">
  <div class="toolbar"><label for="message">Message</label><span class="spacer"></span><select id="history"></select></div>
  <textarea id="message" placeholder="Commit message (optional, Ctrl+Enter to commit)"></textarea>
  <div class="opts">
    <label><input type="checkbox" id="keepLocks"> Keep locks</label>
    <label><input type="checkbox" id="keepChangelists"> Keep changelists</label>
  </div>
  <div class="error" id="error"></div>
  <div class="actions"><button class="primary" id="commit">Commit</button><button class="secondary" id="cancel">Cancel</button><span class="status" id="status"></span></div>
</div>`;

interface DialogRequest {
  repos: RepoEntry[];
  /** Paths to pre-check (the selection the command was started from); undefined = everything committable. */
  scope?: string[];
  /** Commit this changelist: its files are pre-checked, and committing exactly them uses `svn commit --changelist`. */
  changelist?: string;
  /** Commit All: pressing Commit asks for a modal confirmation first. */
  all?: boolean;
}

interface Preserve {
  selected?: string[];
  message?: string;
  keepLocks?: boolean;
  keepChangelists?: boolean;
  error?: string;
}

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export function entriesOf(repo: RepoEntry, items: readonly ChangeItem[]): CommitEntry[] {
  return items
    .filter((i) => i.outgoing)
    .map((i) => ({ repoName: repo.name, path: i.path, item: i.item, props: i.props, changelist: i.changelist, isDir: isDir(i.path), locked: !!i.lock?.token }))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
}

export class CommitDialog {
  private panel?: vscode.WebviewPanel;
  private req: DialogRequest = { repos: [] };
  private entries: CommitEntry[] = [];
  private committing = false;
  private ready = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly services: Services) {}

  private historyLimit(): number {
    return Math.max(0, vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>('commit.historySize', 20));
  }

  private history(): string[] {
    return sanitizeHistory(this.context.globalState.get(HISTORY_KEY), this.historyLimit());
  }

  private tmpDir(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'tmp');
  }

  async open(req: DialogRequest): Promise<void> {
    this.req = req;
    if (!this.panel) this.create();
    else this.panel.reveal();
    // The webview announces 'ready' on creation; for an existing panel push the data right away.
    if (this.ready) await this.sendInit();
  }

  private create(): void {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'commit');
    const panel = vscode.window.createWebviewPanel('svnWorkflow.commit', 'SVN Commit', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot],
    });
    this.panel = panel;
    this.ready = false;
    const nonce = crypto.randomBytes(16).toString('base64');
    const web = panel.webview;
    web.html = webviewHtml({
      cspSource: web.cspSource,
      nonce,
      title: 'SVN Commit',
      scriptUri: web.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'commit.js')).toString(),
      styleUri: web.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'commit.css')).toString(),
      body: BODY,
    });
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
    });
    web.onDidReceiveMessage((m: { type: string; [k: string]: unknown }) => {
      void this.onMessage(m).catch((e) => reportError(this.services, e));
    });
  }

  private async sendInit(p: Preserve = {}): Promise<void> {
    if (!this.panel) return;
    for (const r of this.req.repos) await this.services.incoming.refresh({ repoName: r.name, remote: false });
    this.entries = this.req.repos.flatMap((r) => entriesOf(r, this.services.incoming.getState(r.name)?.items ?? []));
    const present = new Set(this.entries.map((e) => pathKey(e.path)));
    const cl = this.req.changelist;
    const checked = p.selected
      ? p.selected.filter((s) => present.has(pathKey(s)))
      : cl
        ? this.entries.filter((e) => e.changelist === cl && entryKind(e) === 'commit').map((e) => e.path)
        : [...defaultChecked(this.entries, this.req.scope)];
    const repos = this.req.repos.map((r) => ({
      name: r.name,
      entries: this.entries
        .filter((e) => e.repoName === r.name)
        .map((e) => ({
          path: e.path,
          rel: path.relative(r.localFolder, e.path).split(path.sep).join('/'),
          item: e.item,
          props: e.props,
          changelist: e.changelist,
          isDir: e.isDir,
          locked: e.locked,
          kind: entryKind(e),
          reason: entryKind(e) === 'blocked' ? blockedReason(e) : e.item === 'unversioned' ? 'Unversioned: will be added (svn add) and committed when checked' : undefined,
        })),
    }));
    const title = `Commit ${this.req.repos.map((r) => r.name).join(', ')}`;
    this.panel.title = title;
    await this.panel.webview.postMessage({ type: 'init', repos, checked, history: this.history(), title, message: p.message, keepLocks: p.keepLocks, keepChangelists: p.keepChangelists, error: p.error });
  }

  private post(m: unknown): void {
    void this.panel?.webview.postMessage(m);
  }

  private async onMessage(m: { type: string; [k: string]: unknown }): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        await this.sendInit();
        break;
      case 'cancel':
        this.panel?.dispose();
        break;
      case 'refresh':
        if (!this.committing) await this.sendInit({ selected: m.selected as string[], message: m.message as string });
        break;
      case 'showChanges':
        await this.showChanges(String(m.repo), String(m.path));
        break;
      case 'commit':
        if (!this.committing) await this.commit(m as unknown as { message: string; selected: string[]; keepLocks: boolean; keepChangelists: boolean });
        break;
    }
  }

  /** True when the selection is exactly the members of the requested changelist (so `--changelist` is equivalent). */
  private isWholeChangelist(repo: RepoEntry, selected: readonly string[]): boolean {
    const cl = this.req.changelist;
    if (!cl || this.req.repos.length !== 1) return false;
    const members = this.entries.filter((e) => e.repoName === repo.name && e.changelist === cl && entryKind(e) === 'commit').map((e) => pathKey(e.path));
    const sel = new Set(selected.map((p) => pathKey(p)));
    return members.length > 0 && members.length === sel.size && members.every((k) => sel.has(k));
  }

  /** BASE against the working copy in the shared compare view (never vscode.diff). */
  private async showChanges(repoName: string, p: string): Promise<void> {
    const e = this.entries.find((x) => x.repoName === repoName && pathKey(x.path) === pathKey(p));
    if (!e) return;
    const file = vscode.Uri.file(p);
    if (e.item === 'unversioned' || e.item === 'added') {
      await vscode.commands.executeCommand('vscode.open', file, { preview: true });
      return;
    }
    if (e.item === 'deleted' || e.item === 'missing') {
      await vscode.commands.executeCommand('vscode.open', incomingUri(repoName, p, 'BASE'));
      return;
    }
    await openCompare(
      { services: this.services, extensionUri: this.context.extensionUri },
      {
        left: { kind: 'local', fsPath: p, repoName },
        right: { kind: 'rev', repoName, target: p, rev: 'BASE', label: 'BASE (last update)' },
        editableSide: 'left',
        title: `${path.basename(p)} (Working Copy ↔ BASE)`,
      },
    );
  }

  private async commit(m: { message: string; selected: string[]; keepLocks: boolean; keepChangelists: boolean }): Promise<void> {
    const keep: Preserve = { selected: m.selected, message: m.message, keepLocks: m.keepLocks, keepChangelists: m.keepChangelists };
    const plans: Array<{ repo: RepoEntry; plan: CommitPlan }> = this.req.repos
      .map((repo) => ({ repo, plan: buildPlan(repo.name, this.entries, m.selected) }))
      .filter((x) => x.plan.commit.length || x.plan.add.length || x.plan.rejected.length);
    const bad = validateCommit(m.message, plans.map((x) => x.plan));
    if (bad) {
      this.post({ type: 'error', text: bad });
      return;
    }
    if (this.req.all) {
      for (const { repo, plan } of plans.filter((x) => x.plan.commit.length)) {
        const folder = this.services.incoming.scopeOf(repo)[0] ?? repo.localFolder;
        if (!(await confirmBulk('commit', repo.name, folder, plan.commit.length))) return;
      }
    }
    const releases: Array<() => void> = [];
    for (const { repo } of plans.filter((x) => x.plan.commit.length)) {
      const release = repoLocks.tryAcquire(repo.name);
      if (!release) {
        releases.forEach((r) => r());
        this.post({ type: 'error', text: `Another operation is running on "${repo.name}". Try again when it finishes.` });
        return;
      }
      releases.push(release);
    }
    this.committing = true;
    this.post({ type: 'busy', on: true, text: 'Committing...' });
    const done: string[] = [];
    try {
      await runOperation('Committing', async (signal, step) => {
        for (const { repo, plan } of plans) {
          if (!plan.commit.length) continue;
          step(repo.name);
          if (this.isWholeChangelist(repo, m.selected)) {
            const rev = await commitChangelist({ client: this.services.client, repo, signal }, this.req.changelist as string, { message: m.message, tmpDir: this.tmpDir(), keepLocks: m.keepLocks, keepChangelists: m.keepChangelists });
            done.push(rev ? `${repo.name} r${rev}` : `${repo.name} (nothing to commit)`);
            continue;
          }
          const r = await executeCommit({ client: this.services.client, repo, signal }, plan, { message: m.message, tmpDir: this.tmpDir(), keepLocks: m.keepLocks, keepChangelists: m.keepChangelists });
          done.push(r.revision ? `${repo.name} r${r.revision}` : `${repo.name} (nothing to commit)`);
        }
      });
      await this.context.globalState.update(HISTORY_KEY, pushHistory(this.history(), m.message, this.historyLimit()));
      notifySuccess(this.services, `Committed: ${done.join(', ')}.`);
      this.panel?.dispose();
    } catch (e) {
      const text = e instanceof Error ? `${e.message} ${(e as SvnError).stderr ?? ''}` : String(e);
      if (isOutOfDate(text)) await this.outOfDate(plans.filter((x) => x.plan.commit.length), keep);
      else {
        if (done.length) keep.error = `Committed ${done.join(', ')}; the remaining repositories failed.`;
        await this.sendInit(keep);
        await reportError(this.services, e, plans[0]?.repo.name);
      }
    } finally {
      releases.forEach((r) => r());
      this.committing = false;
      for (const { repo } of plans) this.services.incoming.requestRefresh({ repoName: repo.name, remote: true });
    }
  }

  /** Friendly handling of "file is out of date": update, or (single target with incoming changes) Override and Commit. */
  private async outOfDate(plans: Array<{ repo: RepoEntry; plan: CommitPlan }>, keep: Preserve): Promise<void> {
    for (const { repo } of plans) await this.services.incoming.refresh({ repoName: repo.name, remote: true });
    const all = plans.flatMap((x) => x.plan.commit);
    const roots = all.filter((p) => !all.some((q) => pathKey(q) !== pathKey(p) && isSameOrUnder(p, q)));
    const single = roots.length === 1 ? roots[0] : undefined;
    const canOverride = !!single && this.services.incoming.hasIncoming(single);
    await this.sendInit({ ...keep, error: 'The commit was rejected: the server has newer changes for some of these files.' });
    const pick = await vscode.window.showWarningMessage(
      'SVN: the commit was rejected because the server has newer changes for some of these files (they are out of date).',
      { modal: false },
      'Update',
      ...(canOverride ? ['Override and Commit...'] : []),
    );
    if (pick === 'Update') {
      for (const { repo, plan } of plans) {
        const r = await runOperation('Updating', (signal) => updatePaths({ client: this.services.client, repo, signal }, plan.commit.filter((p) => fs.existsSync(p))));
        if (r.conflicts.length) void vscode.window.showWarningMessage(`SVN: update finished with conflicts in ${r.conflicts.join(', ')}. Resolve them before committing.`);
        await this.services.incoming.refresh({ repoName: repo.name, remote: true });
      }
      await this.sendInit({ ...keep, error: 'Updated. Review the changes and commit again.' });
    } else if (pick && single) {
      this.panel?.dispose();
      await vscode.commands.executeCommand('svnWorkflow.overrideCommit', vscode.Uri.file(single));
    }
  }
}

/** Request for the dialog from command targets: only repo roots selected = everything pre-checked, else just the selection. */
export function targetsToRequest(targets: SvnTarget[]): DialogRequest | undefined {
  const repos = new Map<string, RepoEntry>();
  for (const t of targets) repos.set(t.repo.name, t.repo);
  if (!repos.size) return undefined;
  const isRoot = (t: SvnTarget): boolean => pathKey(t.fsPath) === pathKey(t.repo.localFolder);
  return { repos: [...repos.values()], scope: targets.every(isRoot) ? undefined : targets.map((t) => t.fsPath) };
}

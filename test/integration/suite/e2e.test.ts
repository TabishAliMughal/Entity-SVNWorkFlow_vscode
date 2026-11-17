/**
 * End-to-end suite (task 50): the extension in a real VS Code host against the local test servers (test-env/envctl.py),
 * driven through extension commands. Modal dialogs are answered by a script that replaces the vscode.window.show*
 * functions inside the test host; the production code has no test branches except returning its services from
 * activate() when SVN_WORKFLOW_E2E=1. The harness uses svn.exe only to prepare server state a teammate would create
 * ("mate" working copy) and to read results back. Skipped (with a warning) when the servers are not running.
 */
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { E2EApi } from '../../../src/extension';
import { executeCommit } from '../../../src/commit/execute';
import { fetchContent } from '../../../src/compare/fetch';
import { diffLines } from '../../../src/diff';
import { probeCertificate } from '../../../src/svn/certificate';
import { evalWhen } from './when';

const root = path.resolve(__dirname, '../../../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  publisher: string;
  name: string;
  contributes: { commands: { command: string }[]; menus: Record<string, { command?: string; submenu?: string; when?: string }[]> };
};
const SCRATCH = process.env.E2E_SCRATCH ?? 'F:\\TrashCache\\e2e';
const SVN_CONFIG = path.join(SCRATCH, 'svn-config');
const STAMP = String(Date.now());
const RUN = path.join(SCRATCH, `run-${STAMP}`);

interface Case {
  proto: 'svn' | 'https';
  repo: 'alpha' | 'beta';
  base: string;
  https: boolean;
}
const CASES: Case[] = [
  { proto: 'svn', repo: 'alpha', base: 'svn://127.0.0.1:13690/alpha/trunk', https: false },
  { proto: 'https', repo: 'beta', base: 'https://127.0.0.1:18443/svn/beta/trunk', https: true },
];

// ---- dialog script -------------------------------------------------------------------------------------------------
type Answer = string | undefined;
interface Script {
  input?: (o: vscode.InputBoxOptions) => Answer;
  pick?: (items: readonly (string | vscode.QuickPickItem)[], o?: vscode.QuickPickOptions) => unknown;
  warn?: (msg: string, buttons: string[], modal: boolean, detail?: string) => Answer;
  info?: (msg: string, buttons: string[]) => Answer;
  error?: (msg: string, buttons: string[]) => Answer;
  open?: () => vscode.Uri[] | undefined;
}
const seen: string[] = [];
let script: Script = {};
const win = vscode.window as unknown as Record<string, unknown>;
const originals: Record<string, unknown> = {};

function splitArgs(a: unknown[]): { buttons: string[]; modal: boolean; detail?: string } {
  const opts = a[0] && typeof a[0] === 'object' ? (a[0] as { modal?: boolean; detail?: string }) : undefined;
  const rest = opts ? a.slice(1) : a;
  return { buttons: rest.filter((x): x is string => typeof x === 'string'), modal: !!opts?.modal, detail: opts?.detail };
}

function installDialogs(): void {
  const set = (name: string, fn: unknown): void => {
    originals[name] = win[name];
    win[name] = fn;
  };
  set('showInputBox', async (o: vscode.InputBoxOptions = {}) => {
    seen.push(`input:${o.title ?? o.prompt ?? ''}`);
    return script.input?.(o);
  });
  set('showQuickPick', async (items: unknown, o?: vscode.QuickPickOptions) => {
    const list = (await Promise.resolve(items)) as (string | vscode.QuickPickItem)[];
    seen.push(`pick:${o?.title ?? o?.placeHolder ?? ''}`);
    return script.pick?.(list, o);
  });
  set('showWarningMessage', async (msg: string, ...a: unknown[]) => {
    const { buttons, modal, detail } = splitArgs(a);
    seen.push(`warn:${msg}`);
    return script.warn?.(msg, buttons, modal, detail);
  });
  set('showInformationMessage', async (msg: string, ...a: unknown[]) => {
    const { buttons } = splitArgs(a);
    seen.push(`info:${msg}`);
    return script.info?.(msg, buttons);
  });
  set('showErrorMessage', async (msg: string, ...a: unknown[]) => {
    const { buttons } = splitArgs(a);
    seen.push(`error:${msg}`);
    return script.error?.(msg, buttons);
  });
  set('showOpenDialog', async () => script.open?.());
}
function restoreDialogs(): void {
  for (const [k, v] of Object.entries(originals)) win[k] = v;
}
const label = (i: string | vscode.QuickPickItem): string => (typeof i === 'string' ? i : i.label);

// ---- helpers -------------------------------------------------------------------------------------------------------
let api: E2EApi;
let exe = '';
const trace = (m: string): void => fs.appendFileSync(path.join(SCRATCH, 'last-run.log'), `# ${new Date().toISOString()} ${m}`+String.fromCharCode(10));
process.on('uncaughtException', (e) => trace(`uncaught ${e.stack}`));
process.on('unhandledRejection', (e) => trace(`unhandled ${String(e)}`));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 1500 });
    s.on('connect', () => (s.destroy(), resolve(true)));
    s.on('timeout', () => (s.destroy(), resolve(false)));
    s.on('error', () => resolve(false));
  });
}

function svn(c: Case | undefined, args: string[], cwd?: string): string {
  const full = ['--non-interactive', '--config-dir', SVN_CONFIG, ...args];
  if (c) full.push('--username', 'tester', '--password', 'tester-pass', '--no-auth-cache');
  if (c?.https) full.push('--trust-server-cert-failures=unknown-ca,cn-mismatch');
  const r = spawnSync(exe, full, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`svn ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function envctl(args: string[]): void {
  const r = spawnSync('python', [path.join(root, 'test-env', 'envctl.py'), ...args], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`envctl ${args.join(' ')} failed: ${r.stdout}${r.stderr}`);
}

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 20000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

const write = (p: string, text: string): void => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const read = (p: string): string => fs.readFileSync(p, 'utf8');
const samePath = (a: string, b: string): boolean => path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();

async function refresh(name: string): Promise<void> {
  await api.services.incoming.refresh({ repoName: name, remote: true, manual: true });
}
/** refresh() joins a server check that may have started before the teammate's commit, so repeat until the state shows it. */
const settled = <T>(name: string, what: string, pred: () => T): Promise<NonNullable<T>> =>
  until(what, async () => {
    await refresh(name);
    return pred();
  }, 40000);
const items = (name: string) => api.services.incoming.getState(name)?.items ?? [];
const itemOf = (name: string, p: string) => items(name).find((i) => samePath(i.path, p));

function paneItems(name: string): { label: string; contextValue: string; path: string }[] {
  const repoNode = api.pane.getChildren().find((n) => (n as { repo?: { name: string } }).repo?.name === name);
  assert.ok(repoNode, `pane lists repository ${name}`);
  const out: { label: string; contextValue: string; path: string }[] = [];
  const walk = (nodes: ReturnType<typeof api.pane.getChildren>): void => {
    for (const n of nodes) {
      const t = api.pane.getTreeItem(n);
      if (t.resourceUri && t.contextValue !== 'svnFolder') out.push({ label: String(t.label), contextValue: t.contextValue ?? '', path: t.resourceUri.fsPath });
      else walk(api.pane.getChildren(n));
    }
  };
  walk(api.pane.getChildren(repoNode));
  return out;
}

/** Menu entries of a command for a menu location, evaluated against package.json `when` clauses. */
function menuVisible(menu: string, command: string, ctx: Record<string, unknown>): boolean {
  const entries = (pkg.contributes.menus[menu] ?? []).filter((e) => e.command === command);
  assert.ok(entries.length, `${command} is contributed to ${menu}`);
  return entries.some((e) => !e.when || evalWhen(e.when, ctx));
}

function explorerCtx(file: string): Record<string, unknown> {
  const incoming = api.services.incoming.aggregatedIncomingPaths().map((p) => vscode.Uri.file(p).fsPath);
  return {
    resourcePath: vscode.Uri.file(file).fsPath,
    resourceScheme: 'file',
    explorerResourceIsFolder: false,
    'svnWorkflow.hasRepos': true,
    'svnWorkflow.hasIncoming': incoming.length > 0,
    'svnWorkflow.incomingPaths': incoming,
  };
}

const PREV = ['<?php', 'class Dealer {', '    private function loadDealer($id){', '        return $this->db->find($id);', '    }', ''];
const NEWFN = [
  '    private function setDealerBalanceData(){',
  '        $rows = $this->db->query("SELECT * FROM balances");',
  '        $out = array();',
  '        foreach ($rows as $row) {',
  '            if ($row["active"]) {',
  '                $out[$row["dealer_id"]] = $row["amount"];',
  '            }',
  '        }',
  '        $this->cache->put("balances", $out);',
  '        $total = 0;',
  '        foreach ($out as $v) {',
  '            $total += $v;',
  '        }',
  '        $this->log("balance total " . $total);',
  '        $this->audit("balances");',
  '        return $out;',
  '    }',
  '',
];
const BODY = ['        $limit = $this->db->limit($id);', '        return $limit;', '    }', '}'];
const nl = (l: string[]): string => l.map((x) => x + '\n').join('');
const PHP_OLD = nl([...PREV, '    function setDealerCreditLimit($id){', ...BODY]);
const PHP_NEW = nl([...PREV, ...NEWFN, '    function setDealerBalance($id){', ...BODY]);

// ---- the suite -----------------------------------------------------------------------------------------------------
suite('e2e: extension in a VS Code host against the local servers', function () {
  this.timeout(180000);
  let enabled = false;

  suiteSetup(async function () {
    const ext = vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`);
    assert.ok(ext);
    api = (await ext.activate()) as E2EApi;
    assert.ok(api?.services, 'activate() returns the services when SVN_WORKFLOW_E2E=1');
    exe = api.services.locator.getExe();
    const up = (await Promise.all([13690, 18443].map(probe))).every(Boolean);
    enabled = up;
    if (!up) console.warn('[e2e] servers not running (python test-env/envctl.py start): E2E tests skipped');
    fs.mkdirSync(SVN_CONFIG, { recursive: true });
    installDialogs();
  });

  suiteTeardown(async () => {
    restoreDialogs();
    await api.setFocus(undefined);
  });

  setup(function () {
    if (!enabled) this.skip();
    script = {};
    seen.length = 0;
  });

  for (const c of CASES) {
    suite(`${c.repo} over ${c.proto}://`, () => {
      const dir = path.join(RUN, c.proto);
      const mine = path.join(dir, 'my wc ü@home');
      // The repository is named after the opened folder; the test host has no folder open, so the focus folder is pinned.
      const name = path.basename(mine);
      const mate = path.join(dir, 'mate');
      const url = `${c.base}/e2e-${STAMP}`;
      const f = (rel: string): string => path.join(mine, rel);
      const m = (rel: string): string => path.join(mate, rel);
      const mateCommit = (msg: string): void => void svn(c, ['commit', '-m', msg], mate);
      const uri = (rel: string): vscode.Uri => vscode.Uri.file(f(rel));

      suiteSetup(async function () {
        if (!enabled) return this.skip();
        fs.mkdirSync(dir, { recursive: true });
        svn(c, ['mkdir', '-m', 'e2e root', url]);
        svn(c, ['checkout', url, mate]);
        write(m('a.txt'), 'alpha line\n');
        write(m('b.txt'), 'bee line\n');
        write(m('oc.txt'), 'base\n');
        write(m('conf.txt'), 'line1\nline2\nline3\n');
        write(m('code.php'), PHP_OLD);
        write(m('uni-café.txt'), 'unicode\n');
        write(m('dir with space/p q.txt'), 'spaced\n');
        write(m('at@sign.txt'), 'at\n');
        svn(undefined, ['add', '--force', '.'], mate);
        mateCommit('seed');
        svn(c, ['checkout', url, mine]);
        await api.setFocus(mine);
      });

      test('nothing is saved: the working copy of the opened folder is found on the fly and credentials are stored per server', async () => {
        const current = api.services.repos.list();
        assert.strictEqual(current.length, 1, 'exactly one repository');
        assert.ok(samePath(current[0].localFolder, mine) && current[0].name === name);
        assert.strictEqual(vscode.workspace.getConfiguration('svnWorkflow').inspect('repos')?.globalValue, undefined, 'no repository list is persisted');
        assert.ok(!pkg.contributes.commands.some((x) => /addRepo|editRepo|removeRepo|manageRepos|detectWorkingCopies|addExistingWc/.test(x.command)), 'registration commands are gone');

        const askUser = (o: vscode.InputBoxOptions): Answer => (o.title?.startsWith('Username') ? 'tester' : o.title?.startsWith('Password') ? 'tester-pass' : undefined);
        if (!c.https) {
          // The first server check has no credentials: the auth error offers Set Credentials, which asks for username and password.
          script = {
            error: (msg, b) => (/authentication failed/i.test(msg) ? b.find((x) => x === 'Set Credentials') : undefined),
            input: askUser,
          };
          api.services.incoming.scopeChanged(); // clears the cached state so the first failure is reported (and offered) again
          await until('password stored after the first auth failure', async () => (await api.services.passwords.has(url)) || undefined, 30000).catch(async (e) => {
            throw new Error(`${(e as Error).message}; dialogs seen: ${seen.join(' | ')}`);
          });
          assert.ok(seen.some((s) => /^error:SVN authentication failed/i.test(s)), 'auth error offered Set Credentials');
        } else {
          // https: svn's own cache of the harness login can answer, so the prompt is not guaranteed; set the credentials explicitly.
          script = { input: askUser };
          await vscode.commands.executeCommand('svnWorkflow.setCredentials');
          const entry = api.services.repos.list()[0];
          await api.services.repos.update(name, { ...entry, trustServerCert: true, trustedCertFingerprint: (await probeCertificate(c.base)).fingerprint });
          assert.strictEqual(api.services.servers.get(c.base).trustServerCert, true, 'certificate trust is stored per server');
          assert.match(api.services.servers.get(c.base).trustedCertFingerprint ?? '', /^([0-9A-F]{2}:){19}[0-9A-F]{2}$/i);
        }
        assert.strictEqual(await api.services.passwords.get(`${c.base}/other/path`), 'tester-pass', 'password is shared by every repository on the same server origin');
        assert.strictEqual(api.services.repos.find(name)?.username, 'tester');
        assert.ok(api.services.servers.origins().length >= 1);

        script = {};
        await refresh(name);
        assert.strictEqual(api.services.incoming.getState(name)?.error, undefined, 'server check works with stored credentials');
        await vscode.commands.executeCommand('svnWorkflow.showRepoInfo');
        await until('repo info message', () => seen.some((s) => /info:".*": working copy r\d+, server HEAD r\d+/.test(s)));

        // Clear Credentials / Set Credentials act on the current repository's server.
        await vscode.commands.executeCommand('svnWorkflow.clearCredentials');
        assert.strictEqual(await api.services.passwords.has(url), false);
        assert.strictEqual(api.services.repos.find(name)?.username, undefined);
        script = { input: (o) => (o.title?.startsWith('Username') ? 'tester' : o.title?.startsWith('Password') ? 'tester-pass' : undefined) };
        await vscode.commands.executeCommand('svnWorkflow.setCredentials');
        assert.strictEqual(await api.services.passwords.get(url), 'tester-pass', `seen: ${seen.join(' | ')}`);
        await refresh(name);
      });

      test('discovery follows the focus folder: sub-folder scopes the pane, a folder outside any working copy shows the welcome state', async () => {
        const sub = path.join(mine, 'dir with space');
        await api.setFocus(sub);
        const repo = api.services.repos.list()[0];
        assert.ok(repo && samePath(repo.localFolder, mine) && repo.name === 'dir with space', 'working copy found above the opened sub-folder, named after the folder');
        assert.deepStrictEqual(api.services.incoming.scopeOf(repo).map((p) => path.normalize(p).toLowerCase()), [path.normalize(sub).toLowerCase()]);
        assert.strictEqual(api.pane.getChildren().length, 1, 'exactly one repository node');

        await api.setFocus(dir);
        assert.strictEqual(api.services.repos.list().length, 0, 'no working copy: nothing is shown');
        assert.strictEqual(api.pane.getChildren().length, 0);

        await api.setFocus(mine);
        assert.strictEqual(api.services.repos.list()[0]?.name, name);
        await refresh(name);
      });

      test('incoming detection, context keys and menu gating from package.json', async () => {
        write(m('a.txt'), 'alpha line\nmate added\n');
        write(m('new ü file@in.txt'), 'incoming add\n');
        svn(undefined, ['add', 'new ü file@in.txt@'], mate);
        mateCommit('mate: modify + add');
        await vscode.commands.executeCommand('svnWorkflow.refresh');
        const mod = await settled(name, 'incoming a.txt', () => itemOf(name, f('a.txt'))?.incoming);
        assert.ok(mod);
        assert.ok(itemOf(name, f('new ü file@in.txt'))?.incoming);
        assert.ok(!itemOf(name, f('b.txt'))?.incoming);

        const keys = api.services.incoming.aggregatedIncomingPaths().map((p) => vscode.Uri.file(p).fsPath);
        assert.ok(keys.some((p) => samePath(p, f('a.txt'))), 'svnWorkflow.incomingPaths holds the incoming file');
        assert.ok(!keys.some((p) => samePath(p, f('b.txt'))));
        assert.ok(keys.length > 0, 'svnWorkflow.hasIncoming');

        assert.ok((pkg.contributes.menus['explorer/context'] ?? []).some((e) => e.submenu === 'svnWorkflow.submenu'), 'the SVN submenu hangs off the Explorer context menu');
        assert.strictEqual(menuVisible('svnWorkflow.submenu', 'svnWorkflow.overrideUpdate', explorerCtx(f('a.txt'))), true);
        assert.strictEqual(menuVisible('svnWorkflow.submenu', 'svnWorkflow.overrideUpdate', explorerCtx(f('b.txt'))), false);
        assert.strictEqual(menuVisible('svnWorkflow.submenu', 'svnWorkflow.overrideCommit', explorerCtx(f('a.txt'))), true);
        assert.strictEqual(menuVisible('svnWorkflow.submenu', 'svnWorkflow.overrideCommit', explorerCtx(f('b.txt'))), false);

        // the command guard is the real check: no incoming under b.txt means nothing destructive is offered
        write(f('b.txt'), 'LOCAL EDIT b\n');
        await vscode.commands.executeCommand('svnWorkflow.overrideUpdate', uri('b.txt'));
        assert.ok(!seen.some((s) => s.startsWith('warn:Override and Update:')), 'no confirmation for a file without incoming changes');
        assert.strictEqual(read(f('b.txt')), 'LOCAL EDIT b\n');
      });

      test('pane labels "<file> (last committer)", filters Outgoing / Incoming / All, view item menus', async () => {
        await refresh(name);
        const incLabel = await until('author in label', () => {
          const it = paneItems(name).find((i) => samePath(i.path, f('a.txt')));
          return it && /^a\.txt \(tester\)$/.test(it.label) ? it : undefined;
        }, 30000);
        assert.match(incLabel.contextValue, /\bsvnItem\b.*\bincoming\b/);
        const outLabel = paneItems(name).find((i) => samePath(i.path, f('b.txt')));
        assert.ok(outLabel && /\boutgoing\b/.test(outLabel.contextValue), 'locally modified b.txt is outgoing');

        await vscode.commands.executeCommand('svnWorkflow.pane.filterIncoming');
        assert.strictEqual(api.pane.getFilter(), 'incoming');
        let shown = paneItems(name);
        assert.ok(shown.length >= 2 && shown.every((i) => /\bincoming\b/.test(i.contextValue)));
        await vscode.commands.executeCommand('svnWorkflow.pane.filterOutgoing');
        shown = paneItems(name);
        assert.ok(shown.some((i) => samePath(i.path, f('b.txt'))) && shown.every((i) => /\boutgoing\b/.test(i.contextValue)));
        await vscode.commands.executeCommand('svnWorkflow.pane.filterAll');
        shown = paneItems(name);
        assert.ok(shown.some((i) => /\bincoming\b/.test(i.contextValue)) && shown.some((i) => /\boutgoing\b/.test(i.contextValue)));

        const viewCtx = (cv: string): Record<string, unknown> => ({ view: 'svnWorkflow.pane', viewItem: cv });
        assert.strictEqual(menuVisible('view/item/context', 'svnWorkflow.overrideUpdate', viewCtx(incLabel.contextValue)), true);
        assert.strictEqual(menuVisible('view/item/context', 'svnWorkflow.overrideUpdate', viewCtx(outLabel.contextValue)), false);
      });

      test('pane scoping: a workspace folder inside the working copy narrows the pane; unrelated repos are hidden; tree/list modes', async () => {
        const sub = f('dir with space');
        const probe = path.join(sub, 'scope-probe.txt');
        write(probe, 'probe\n');
        const inc = api.services.incoming;
        const original = inc.scope;
        try {
          await refresh(name);
          assert.ok(paneItems(name).some((i) => samePath(i.path, probe)) && paneItems(name).some((i) => samePath(i.path, f('b.txt'))));

          inc.scope = (r) => (r.name === name ? [sub] : []);
          inc.scopeChanged();
          await until('pane narrowed to the sub-folder', () => {
            const items = paneItems(name);
            return items.length > 0 && items.every((i) => samePath(path.dirname(i.path), sub)) && items.some((i) => samePath(i.path, probe));
          }, 30000);
          assert.ok(!inc.allItems().some((i) => samePath(i.path, f('b.txt'))), 'items outside the folder are gone from the shared state');
          assert.ok(!inc.hasIncoming(f('a.txt')), 'incoming outside the folder is not reported');

          await vscode.commands.executeCommand('svnWorkflow.pane.viewAsList');
          assert.strictEqual(api.pane.getViewMode(), 'list');
          const listed = api.pane.getChildren(api.pane.getChildren().find((n) => (n as { repo?: { name: string } }).repo?.name === name));
          assert.ok(listed.every((n) => api.pane.getTreeItem(n).contextValue !== 'svnFolder'), 'list mode has no folder nodes');
          await vscode.commands.executeCommand('svnWorkflow.pane.viewAsTree');

          inc.scope = () => [];
          inc.scopeChanged();
          assert.ok(!api.pane.getChildren().some((n) => (n as { repo?: { name: string } }).repo?.name === name), 'repository outside the workspace is hidden');
        } finally {
          inc.scope = original;
          fs.rmSync(probe, { force: true });
          inc.scopeChanged();
          await settled(name, 'full scope restored', () => paneItems(name).some((i) => samePath(i.path, f('b.txt'))));
        }
      });

      test('Update All asks for a modal confirmation naming repo, folder and incoming count; cancel does nothing', async () => {
        const inc = api.services.incoming;
        const only = inc.scope;
        inc.scope = (r) => (r.name === name ? [r.localFolder] : []);
        try {
        await refresh(name);
        const modals: string[] = [];
        const details: string[] = [];
        script = {
          warn: (msg, _b, modal, detail) => {
            if (modal && /^Update all of/.test(msg)) {
              modals.push(msg);
              details.push(detail ?? '');
            }
            return undefined;
          },
        };
        const rev = (): number => Number(svn(c, ['info', '--show-item', 'revision'], mine).trim());
        const before = rev();
        await vscode.commands.executeCommand('svnWorkflow.pane.updateAll');
        assert.strictEqual(modals.length, 1, 'one modal confirmation');
        assert.ok(modals[0].includes(name));
        assert.strictEqual(rev(), before, 'cancel leaves the working copy alone');
        assert.ok(details[0]?.includes(path.basename(mine)) && /\d+ incoming items?/.test(details[0]), 'detail has folder and count');
        } finally {
          inc.scope = only;
        }
      });

      test('Override and Update discards the local edit and takes the server version', async () => {
        write(f('a.txt'), 'LOCAL EDIT a\n');
        script = { warn: (_m, b) => b.find((x) => x === 'Override and Update') };
        await vscode.commands.executeCommand('svnWorkflow.overrideUpdate', uri('a.txt'));
        await until('update done', () => read(f('a.txt')) === 'alpha line\nmate added\n');
        assert.ok(seen.some((s) => /^warn:Override and Update: discard 1 local change/.test(s)));
        await refresh(name);
        assert.ok(!itemOf(name, f('a.txt'))?.incoming && !itemOf(name, f('a.txt'))?.outgoing);
        assert.ok(!fs.existsSync(f('new ü file@in.txt')), 'Override and Update only touches its target');
        assert.ok(itemOf(name, f('new ü file@in.txt'))?.incoming);
        await vscode.commands.executeCommand('svnWorkflow.update', vscode.Uri.file(mine));
        await until('plain update', () => fs.existsSync(f('new ü file@in.txt')));
        write(f('b.txt'), 'bee line\n');
      });

      test('add, ignore and commit with paths containing spaces, unicode and @', async () => {
        write(f('new ü file@x.txt'), 'brand new\n');
        write(f('dir2 with space/c d.txt'), 'in folder\n');
        write(f('debug.log'), 'noise\n');
        await refresh(name);
        assert.strictEqual(itemOf(name, f('new ü file@x.txt'))?.item, 'unversioned');

        script = { pick: (list) => list.find((i) => /Everything inside/.test(label(i))) };
        await vscode.commands.executeCommand('svnWorkflow.add', uri('new ü file@x.txt'));
        await vscode.commands.executeCommand('svnWorkflow.add', uri('dir2 with space'));
        await refresh(name);
        assert.strictEqual(itemOf(name, f('new ü file@x.txt'))?.item, 'added');
        assert.strictEqual(itemOf(name, f('dir2 with space/c d.txt'))?.item, 'added');

        script = { pick: (list) => list.find((i) => /By name/.test(label(i))) };
        await vscode.commands.executeCommand('svnWorkflow.ignore', uri('debug.log'));
        assert.match(svn(undefined, ['propget', 'svn:ignore', '.'], mine), /debug\.log/);
        await refresh(name);
        assert.strictEqual(itemOf(name, f('debug.log')), undefined, 'ignored file is no longer listed');

        // the commit dialog is a webview (manual checklist); the dialog's commit step runs here directly
        const repo = api.services.repos.find(name)!;
        const r = await executeCommit(
          { client: api.services.client, repo },
          { repoName: name, add: [], commit: [f('new ü file@x.txt'), f('dir2 with space'), f('dir2 with space/c d.txt'), mine], implied: [] } as never,
          { message: 'e2e: add + ignore ü', tmpDir: api.services.tmpDir },
        ).catch((e: Error & { stderr?: string }) => {
          throw new Error(`${e.message} ${e.stderr ?? ''}`);
        });
        assert.ok(r.revision && r.revision > 0);
        svn(c, ['update'], mate);
        assert.ok(fs.existsSync(m('new ü file@x.txt')) && fs.existsSync(m('dir2 with space/c d.txt')));
        assert.ok(!fs.existsSync(m('debug.log')));

        await vscode.commands.executeCommand('svnWorkflow.commit', uri('a.txt'));
        await sleep(500);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      });

      test('Override and Commit keeps the local version over a teammate change (confirm stubbed)', async () => {
        write(m('oc.txt'), 'teammate version\n');
        mateCommit('mate edits oc');
        write(f('oc.txt'), 'LOCAL WINS\n');
        await settled(name, 'oc.txt incoming and outgoing', () => itemOf(name, f('oc.txt'))?.incoming && itemOf(name, f('oc.txt'))?.outgoing);
        assert.strictEqual(menuVisible('svnWorkflow.submenu', 'svnWorkflow.overrideCommit', explorerCtx(f('oc.txt'))), true);

        script = {
          warn: (_m, b) => b.find((x) => x === 'Override and Commit'),
          input: (o) => (o.title === 'Override and Commit' ? 'e2e override commit ü' : undefined),
        };
        await vscode.commands.executeCommand('svnWorkflow.overrideCommit', uri('oc.txt'));
        await until('override commit finished', () => seen.some((s) => /^info:Override and Commit finished: committed revision \d+/.test(s)), 40000);
        svn(c, ['update'], mate);
        assert.strictEqual(read(m('oc.txt')), 'LOCAL WINS\n');
        assert.match(svn(c, ['log', '-l', '1', 'oc.txt'], mate), /e2e override commit/);
      });

      test('blame is off by default and toggles per editor only', async () => {
        const docB = await vscode.workspace.openTextDocument(uri('b.txt'));
        await vscode.window.showTextDocument(docB);
        assert.strictEqual(api.blame.isOn(), false, 'a newly opened file has no blame');
        await vscode.commands.executeCommand('svnWorkflow.blame.toggle');
        assert.strictEqual(api.blame.isOn(), true);
        const docA = await vscode.workspace.openTextDocument(uri('a.txt'));
        await vscode.window.showTextDocument(docA);
        assert.strictEqual(api.blame.isOn(), false, 'toggling one file does not switch on another');
        assert.strictEqual(api.blame.isEnabled(docB), true);
        await vscode.window.showTextDocument(docB);
        assert.strictEqual(api.blame.isOn(), true);
        await vscode.commands.executeCommand('svnWorkflow.blame.toggle');
        assert.strictEqual(api.blame.isOn(), false);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      });

      test('compare view opens; D13 insertion above a renamed function aligns on real fetched content', async () => {
        write(m('code.php'), PHP_NEW);
        mateCommit('mate: insert function + rename');
        await settled(name, 'code.php incoming', () => itemOf(name, f('code.php'))?.incoming);

        const client = api.services.client;
        const local = await fetchContent(client, { repoName: name, target: f('code.php'), rev: 'BASE' });
        const head = await fetchContent(client, { repoName: name, target: f('code.php'), rev: 'HEAD' });
        assert.strictEqual(local.text, PHP_OLD);
        assert.strictEqual(head.text, PHP_NEW);
        const d = diffLines(local.text, head.text);
        assert.deepStrictEqual(d.hunks.map((h) => h.type).sort(), ['insert', 'modify']);
        const ins = d.hunks.find((h) => h.type === 'insert')!;
        const mod = d.hunks.find((h) => h.type === 'modify')!;
        assert.strictEqual(ins.incomingEnd - ins.incomingStart, NEWFN.length, 'insertion hunk is exactly the new function');
        assert.strictEqual(mod.localEnd - mod.localStart, 1);
        assert.strictEqual(mod.incomingEnd - mod.incomingStart, 1);
        assert.ok(mod.words && mod.words.local.length > 0, 'renamed function has word-level highlight');

        const before = vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;
        await vscode.commands.executeCommand('svnWorkflow.compareWithIncoming', uri('code.php'));
        await until('compare view tab', () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).length > before, 15000);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');

        await vscode.commands.executeCommand('svnWorkflow.update', uri('code.php'));
        await until('code.php updated', () => read(f('code.php')) === PHP_NEW);
      });

      test('conflict is created by update and resolved with a command', async () => {
        write(m('conf.txt'), 'mate1\nline2\nline3\n');
        mateCommit('mate edits conf line1');
        write(f('conf.txt'), 'mine1\nline2\nline3\n');
        await vscode.commands.executeCommand('svnWorkflow.update', uri('conf.txt'));
        await until('conflicted', async () => {
          await refresh(name);
          return itemOf(name, f('conf.txt'))?.item === 'conflicted';
        });
        assert.ok(api.pane.getChildren(api.pane.getChildren().find((n) => (n as { repo?: { name: string } }).repo?.name === name)).some((n) => api.pane.getTreeItem(n).label === 'Conflicts'), 'pane has a Conflicts group');

        script = { warn: (_m, b) => b.find((x) => x === 'Resolve') };
        await vscode.commands.executeCommand('svnWorkflow.conflict.mineFull', uri('conf.txt'));
        await until('resolved', async () => {
          await refresh(name);
          return itemOf(name, f('conf.txt'))?.item === 'modified';
        });
        assert.strictEqual(read(f('conf.txt')), 'mine1\nline2\nline3\n');
      });

      test('lock and unlock, unicode path', async () => {
        script = { input: (o) => (/^Lock/.test(o.title ?? '') ? 'e2e lock' : undefined) };
        await vscode.commands.executeCommand('svnWorkflow.lock', uri('uni-café.txt'));
        await until('lock token', () => /Lock Token/.test(svn(c, ['info', 'uni-café.txt@'], mine)));
        script = {};
        await vscode.commands.executeCommand('svnWorkflow.unlock', uri('uni-café.txt'));
        await until('unlocked', () => !/Lock Token/.test(svn(c, ['info', 'uni-café.txt@'], mine)));
      });

      test('property set (svn:needs-lock) on a file in a folder with a space, and back', async () => {
        const rel = 'dir with space/p q.txt';
        await vscode.commands.executeCommand('svnWorkflow.props.toggleNeedsLock', uri(rel));
        await until('prop set', () => svn(undefined, ['propget', 'svn:needs-lock', rel + '@'], mine).trim() === '*');
        await vscode.commands.executeCommand('svnWorkflow.props.toggleNeedsLock', uri(rel));
        await until('prop removed', () => svn(undefined, ['proplist', rel + '@'], mine).indexOf('svn:needs-lock') < 0);
      });

      test('envctl incoming change shows up in the shared working copy', async function () {
        const wc1 = `F:\\TrashCache\\svn-test-env\\wc\\${c.repo}-${c.proto}\\wc1`;
        if (!fs.existsSync(wc1)) return this.skip();
        svn(c, ['revert', '-R', '.'], wc1);
        svn(c, ['update'], wc1);
        await api.setFocus(wc1);
        const rname = path.basename(wc1);
        assert.strictEqual(api.services.repos.list()[0]?.name, rname, 'the shared working copy became the current repository');
        await api.services.servers.set(c.base, { username: 'tester', trustServerCert: c.https || undefined, trustedCertFingerprint: c.https ? (await probeCertificate(c.base)).fingerprint : undefined });
        await api.services.passwords.set(c.base, 'tester-pass');
        await refresh(rname);
        assert.ok(!api.services.incoming.getState(rname)?.items.some((i) => i.incoming), 'nothing incoming before');
        envctl(['incoming', '--repo', c.repo, '--proto', c.proto, '--action', 'Modify']);
        await vscode.commands.executeCommand('svnWorkflow.refresh');
        await settled(rname, 'incoming from envctl', () => items(rname).some((i) => i.incoming));
        const paths = api.services.incoming.aggregatedIncomingPaths();
        assert.ok(paths.some((p) => items(rname).some((i) => i.incoming && samePath(i.path, p))), 'incomingPaths feeds the context key');
        await until('label with committer', () => paneItems(rname).some((i) => /\)$/.test(i.label) && /\bincoming\b/.test(i.contextValue)), 30000);
        await api.setFocus(mine);
      });
    });
  }
});

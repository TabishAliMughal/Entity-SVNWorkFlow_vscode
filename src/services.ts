import * as path from 'node:path';
import * as vscode from 'vscode';
import { PasswordStore, RepoCredentialProvider } from './repos/credentials';
import { RepoStore } from './repos/store';
import { ServerStore } from './repos/servers';
import { discoverRepo } from './repos/current';
import { RepoResolver } from './repos/resolver';
import { SvnClient } from './svn/client';
import { SvnLocator } from './svn/locator';
import { LineLogger, Logger } from './util/logger';
import { AuthorResolver } from './incoming/authors';
import { IncomingService } from './incoming/service';
import { LocalIgnoreStore } from './localignore/store';
import { isLocalIgnored, setLocalIgnoreSource } from './localignore/model';
import { focusFolder, pickScope } from './incoming/scope';
import { repoLocks } from './override/commitLocks';
import { ExternalsGuard } from './externals/guard';
import { CertGuard } from './repos/certGuard';
import { confirmCertificateChanged, promptExternals } from './util/trustUi';

export const CONFIG_SECTION = 'svnWorkflow';
export const UNTRUSTED_MESSAGE = 'SVN operations are disabled in untrusted workspaces. Trust this workspace to use the extension.';

/** Everything later features need; created once in activate() and passed to command registrars. */
export interface Services {
  output: vscode.OutputChannel;
  logger: Logger;
  locator: SvnLocator;
  client: SvnClient;
  passwords: PasswordStore;
  repos: RepoStore;
  /** Username, certificate trust and trusted externals hosts per server origin. */
  servers: ServerStore;
  resolver: RepoResolver;
  /** Cached outgoing/incoming state per repo; call `incoming.requestRefresh({ repoName, remote: true })` after SVN operations. */
  incoming: IncomingService;
  authors: AuthorResolver;
  /** Workspace-local list of files the extension must never commit or update. */
  localIgnore: LocalIgnoreStore;
  externals: ExternalsGuard;
  certs: CertGuard;
  extensionId: string;
  /** Scratch folder for message/property files; cleaned at activation. */
  tmpDir: string;
  /** Finds the working copy of the focus folder again (folder/editor change, new checkout); re-scopes the pane. */
  rediscover(): Promise<void>;
}

/** Workspace folder the Changes pane follows: that of the active editor, else the first folder. */
let focusOverride: string | undefined;
/** E2E seam: the test host has no folder open, so tests pin the focus folder. */
export function setFocusOverride(folder: string | undefined): void {
  focusOverride = folder;
}

export function currentFocus(): string | undefined {
  if (focusOverride) return focusOverride;
  const file = vscode.window.activeTextEditor?.document.uri;
  return focusFolder((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath), file?.scheme === 'file' ? file.fsPath : undefined);
}

export function createServices(context: vscode.ExtensionContext): Services {
  const output = vscode.window.createOutputChannel('SVN');
  context.subscriptions.push(output);
  const logger = new LineLogger(output);

  const cfg = () => vscode.workspace.getConfiguration(CONFIG_SECTION);
  const locator = new SvnLocator(() => cfg().get<string>('svnPath', ''));
  const passwords = new PasswordStore(context.secrets);
  const servers = new ServerStore(context.globalState);
  const repos = new RepoStore(servers);
  const client = new SvnClient(locator, new RepoCredentialProvider(repos, passwords), logger, () => cfg().get<number>('commandTimeoutSeconds', 120) * 1000);
  const resolver = new RepoResolver(() => repos.list());
  const incoming = new IncomingService(client, () => repos.list(), logger);
  incoming.scope = (repo) => {
    const pick = pickScope(repos.list(), currentFocus());
    return pick?.name === repo.name ? [pick.target] : [];
  };
  const authors = new AuthorResolver(client, logger);
  const localIgnore = new LocalIgnoreStore(context.workspaceState);
  setLocalIgnoreSource(() => localIgnore.paths());
  incoming.isLocalIgnored = (p) => isLocalIgnored(p, localIgnore.paths());
  context.subscriptions.push(localIgnore.onDidChange(() => incoming.localIgnoreChanged()));
  const externals = new ExternalsGuard({
    client,
    findRepo: (n) => repos.find(n),
    prompt: promptExternals,
    trust: async (name, origins) => {
      const r = repos.find(name);
      if (r) await repos.update(r.name, { ...r, trustedExternalHosts: [...new Set([...(r.trustedExternalHosts ?? []), ...origins])] });
    },
    logger,
  });
  client.setExternalsPolicy(externals);
  client.setExecutionGate(() => (vscode.workspace.isTrusted ? undefined : UNTRUSTED_MESSAGE));
  const certs = new CertGuard({
    findRepo: (n) => repos.find(n),
    repin: async (name, fingerprint) => {
      const r = repos.find(name);
      if (r) await repos.update(r.name, { ...r, trustedCertFingerprint: fingerprint });
    },
    confirmChanged: confirmCertificateChanged,
    logger,
  });
  client.setCertificatePolicy(certs.policy);
  if (process.env.SVN_WORKFLOW_E2E === '1' && process.env.SVN_WORKFLOW_E2E_CONFIG_DIR) client.setConfigDir(process.env.SVN_WORKFLOW_E2E_CONFIG_DIR);
  incoming.isRepoBusy = (name) => repoLocks.isBusy(name) || !vscode.workspace.isTrusted;
  context.subscriptions.push(repoLocks.onRelease((name) => {
    externals.invalidate(name);
    incoming.repoReleased(name);
  }));
  context.subscriptions.push({ dispose: () => incoming.dispose() });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CONFIG_SECTION}.svnPath`)) {
        locator.invalidate();
        logger.info(`svnPath changed; now ${locator.discover().path ?? 'not found'}`);
      }
    }),
  );
  const rediscover = async (): Promise<void> => {
    if (!vscode.workspace.isTrusted) return;
    const found = await discoverRepo(client, currentFocus(), logger);
    if (!repos.setCurrent(found)) incoming.scopeChanged();
  };
  return { rediscover, output, logger, locator, client, passwords, repos, servers, resolver, incoming, authors, localIgnore, externals, certs, extensionId: context.extension.id, tmpDir: path.join(context.globalStorageUri.fsPath, 'tmp') };
}

import { CredentialProvider, Credentials } from '../svn/client';
import { serverKey } from './servers';
import { RepoStore } from './store';

/** Subset of vscode.SecretStorage. */
export interface SecretsLike {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}

const PREFIX = 'svnWorkflow.password.';

/** Per-server password in SecretStorage, keyed by origin (scheme://host:port). Pass a server URL or an origin. */
export class PasswordStore {
  constructor(private readonly secrets: SecretsLike) {}

  static key(urlOrOrigin: string): string {
    return PREFIX + serverKey(urlOrOrigin);
  }

  async get(urlOrOrigin: string): Promise<string | undefined> {
    return (await this.secrets.get(PasswordStore.key(urlOrOrigin))) || undefined;
  }

  async set(urlOrOrigin: string, password: string): Promise<void> {
    await this.secrets.store(PasswordStore.key(urlOrOrigin), password);
  }

  async clear(urlOrOrigin: string): Promise<void> {
    await this.secrets.delete(PasswordStore.key(urlOrOrigin));
  }

  async has(urlOrOrigin: string): Promise<boolean> {
    return !!(await this.get(urlOrOrigin));
  }
}

/** What the SvnClient uses: username/trust flag of the server, password from SecretStorage. */
export class RepoCredentialProvider implements CredentialProvider {
  constructor(private readonly repos: RepoStore, private readonly passwords: PasswordStore) {}

  async get(repoName: string): Promise<Credentials | undefined> {
    const repo = this.repos.find(repoName);
    if (!repo) return undefined;
    return {
      username: repo.username || undefined,
      password: await this.passwords.get(repo.serverUrl),
      trustServerCert: repo.trustServerCert === true && /^https:\/\//i.test(repo.serverUrl),
    };
  }
}

import { describe, expect, it } from 'vitest';
import { PasswordStore, RepoCredentialProvider, SecretsLike } from '../../src/repos/credentials';
import { ServerStore, type MementoLike } from '../../src/repos/servers';
import { RepoStore } from '../../src/repos/store';

function memento(): MementoLike {
  const m = new Map<string, unknown>();
  return { get: <T,>(k: string, d: T) => (m.has(k) ? (m.get(k) as T) : d), update: async (k, v) => void m.set(k, v) };
}


function fakeSecrets(): SecretsLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k) => map.get(k),
    store: async (k, v) => {
      map.set(k, v);
    },
    delete: async (k) => {
      map.delete(k);
    },
  };
}

describe('PasswordStore', () => {
  it('keys by the server origin (scheme://host:port, default port explicit) with the svnWorkflow prefix', () => {
    expect(PasswordStore.key('https://Host/svn/repo1')).toBe('svnWorkflow.password.https://host:443');
    expect(PasswordStore.key('https://host:443/other')).toBe(PasswordStore.key('https://HOST/svn/repo1'));
    expect(PasswordStore.key('svn://h/a')).toBe('svnWorkflow.password.svn://h:3690');
    expect(PasswordStore.key('svn://h:3691/a')).not.toBe(PasswordStore.key('svn://h/a'));
  });
  it('set/get/has/clear', async () => {
    const s = fakeSecrets();
    const p = new PasswordStore(s);
    expect(await p.has('svn://h/a')).toBe(false);
    await p.set('svn://h/a', 'pw');
    expect(s.map.get('svnWorkflow.password.svn://h:3690')).toBe('pw');
    expect(await p.get('svn://H:3690/zzz')).toBe('pw');
    await p.clear('svn://h/b');
    expect(await p.get('svn://h/a')).toBeUndefined();
  });
  it('treats an empty stored value as no password', async () => {
    const s = fakeSecrets();
    s.map.set('svnWorkflow.password.svn://x:3690', '');
    expect(await new PasswordStore(s).get('svn://x/r')).toBeUndefined();
  });
});

describe('RepoCredentialProvider', () => {
  const servers = new ServerStore(memento());
  const repos = new RepoStore(servers);
  repos.setCurrent({ name: 'a', serverUrl: 'https://h/a', localFolder: 'C:\\a' });
  it('combines the server settings with the stored password of the origin', async () => {
    await servers.set('https://h/zzz', { username: 'u', trustServerCert: true });
    const pw = new PasswordStore(fakeSecrets());
    await pw.set('https://h:443/other', 'secret');
    const prov = new RepoCredentialProvider(repos, pw);
    expect(await prov.get('A')).toEqual({ username: 'u', password: 'secret', trustServerCert: true });
    expect(await prov.get('nope')).toBeUndefined();
  });
  it('other servers do not share credentials', async () => {
    const r2 = new RepoStore(servers);
    r2.setCurrent({ name: 'b', serverUrl: 'svn://h/b', localFolder: 'C:\\b' });
    const prov = new RepoCredentialProvider(r2, new PasswordStore(fakeSecrets()));
    expect(await prov.get('b')).toEqual({ username: undefined, password: undefined, trustServerCert: false });
  });
});

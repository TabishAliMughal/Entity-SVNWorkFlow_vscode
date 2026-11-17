import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RepoEntry, checkServerUrl, normalizeUrl, urlsRelated } from '../../src/repos/model';
import { NoRepoError, RepoResolver, normalizePath, resolveRepo } from '../../src/repos/resolver';
import { ServerStore, type MementoLike } from '../../src/repos/servers';
import { RepoStore } from '../../src/repos/store';
import { findWcRootUp } from '../../src/repos/discover';
import { discoverRepo } from '../../src/repos/current';

const mk = (name: string, localFolder: string): RepoEntry => ({ name, serverUrl: `svn://h/${name}`, localFolder });

describe('model', () => {
  it('accepts supported schemes and normalizes', () => {
    for (const u of ['svn://h/r', 'http://h/r', 'https://h:8443/svn/r', 'svn+ssh://h/r']) expect(checkServerUrl(u).ok).toBe(true);
    expect(checkServerUrl(' SVN://HOST/Repo/// ').url).toBe('svn://host/Repo');
  });
  it('rejects bad input', () => {
    expect(checkServerUrl('').ok).toBe(false);
    expect(checkServerUrl('nonsense').ok).toBe(false);
    expect(checkServerUrl('file:///x').error).toMatch(/Scheme/);
    expect(checkServerUrl('svn://u:p@h/r').error).toMatch(/credentials/);
    expect(checkServerUrl('svn://u@h/r').ok).toBe(false);
  });
  it('urlsRelated', () => {
    expect(urlsRelated('svn://h/a', 'svn://H/a/trunk')).toBe(true);
    expect(urlsRelated('svn://h/a/trunk', 'svn://h/a')).toBe(true);
    expect(urlsRelated('svn://h/a', 'svn://h/ab')).toBe(false);
    expect(normalizeUrl('http://H:80/X/')).toBe('http://h:80/X');
  });
});

describe('resolver', () => {
  const repos = [mk('outer', 'C:\\work\\outer'), mk('inner', 'C:\\work\\outer\\inner'), mk('other', 'D:\\other\\')];
  const w = { platform: 'win32' as const };
  it('longest prefix wins regardless of list order', () => {
    expect(resolveRepo('C:\\work\\outer\\inner\\f.txt', repos, w)?.name).toBe('inner');
    expect(resolveRepo('C:\\work\\outer\\inner\\f.txt', [...repos].reverse(), w)?.name).toBe('inner');
    expect(resolveRepo('C:\\work\\outer\\f.txt', repos, w)?.name).toBe('outer');
  });
  it('matches the folder itself, trailing separators, and forward slashes', () => {
    expect(resolveRepo('C:\\work\\outer', repos, w)?.name).toBe('outer');
    expect(resolveRepo('C:\\work\\outer\\', repos, w)?.name).toBe('outer');
    expect(resolveRepo('C:/work/outer/x', repos, w)?.name).toBe('outer');
    expect(resolveRepo('D:\\other\\x', repos, w)?.name).toBe('other');
  });
  it('is case-insensitive on windows only', () => {
    expect(resolveRepo('c:\\WORK\\OUTER\\x', repos, w)?.name).toBe('outer');
    expect(resolveRepo('/Work/a', [mk('p', '/work')], { platform: 'posix' })).toBeUndefined();
    expect(resolveRepo('/work/a', [mk('p', '/work')], { platform: 'posix' })?.name).toBe('p');
    expect(resolveRepo('/Work/a', [mk('p', '/work')], { platform: 'posix', caseInsensitive: true })?.name).toBe('p');
  });
  it('rejects sibling-prefix, relative, empty and other drives', () => {
    expect(resolveRepo('C:\\work\\outerx\\f', repos, w)).toBeUndefined();
    expect(resolveRepo('relative\\f', repos, w)).toBeUndefined();
    expect(resolveRepo('', repos, w)).toBeUndefined();
    expect(resolveRepo('E:\\work\\outer\\f', repos, w)).toBeUndefined();
  });
  it('normalizes dot segments', () => {
    expect(resolveRepo('C:\\work\\outer\\..\\other\\x', repos, w)).toBeUndefined();
    expect(normalizePath('C:\\A\\B\\', w)).toBe('c:\\a\\b');
    expect(normalizePath('C:\\', w)).toBe('c:\\');
  });
  it('RepoResolver.require throws NoRepoError; follows live repo list', () => {
    let list = [mk('a', 'C:\\a')];
    const r = new RepoResolver(() => list, w);
    expect(r.require('C:\\a\\x').name).toBe('a');
    expect(() => r.require('C:\\zzz')).toThrow(NoRepoError);
    list = [];
    expect(r.resolve('C:\\a\\x')).toBeUndefined();
  });
});

function memento(): MementoLike & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return { map, get: <T,>(k: string, d: T) => (map.has(k) ? (map.get(k) as T) : d), update: async (k, v) => void map.set(k, v) };
}

describe('RepoStore (one current working copy, nothing saved)', () => {
  const make = () => {
    const m = memento();
    const servers = new ServerStore(m);
    return { store: new RepoStore(servers), servers, m };
  };
  const wc = { name: 'visp2', serverUrl: 'https://h/svn/websites/visp2', localFolder: 'C:\\websites' };
  it('is empty until a working copy is found, then holds exactly one', () => {
    const { store } = make();
    expect(store.list()).toEqual([]);
    expect(store.setCurrent(wc)).toBe(true);
    expect(store.setCurrent({ ...wc })).toBe(false);
    expect(store.list()).toHaveLength(1);
    expect(store.find('VISP2')?.localFolder).toBe('C:\\websites');
    store.setCurrent(undefined);
    expect(store.list()).toEqual([]);
  });
  it('keeps username, trust and trusted hosts per server origin, not per working copy', async () => {
    const { store, servers, m } = make();
    store.setCurrent(wc);
    await store.update('visp2', { ...store.list()[0], username: 'bob', trustServerCert: true, trustedCertFingerprint: 'AA:BB', trustedExternalHosts: ['svn://x:3690'] });
    expect(servers.get('https://h:443/anything')).toMatchObject({ username: 'bob', trustServerCert: true, trustedCertFingerprint: 'AA:BB', trustedExternalHosts: ['svn://x:3690'] });
    store.setCurrent({ name: 'other', serverUrl: 'https://h/svn/else', localFolder: 'C:\\else' });
    expect(store.list()[0]).toMatchObject({ username: 'bob', trustServerCert: true });
    store.setCurrent({ name: 'o2', serverUrl: 'https://other/svn', localFolder: 'C:\\o2' });
    expect(store.list()[0].username).toBeUndefined();
    expect(JSON.stringify([...m.map.values()])).not.toContain('localFolder');
  });
  it('update refuses a repository that is not current; relocate updates the URL', async () => {
    const { store } = make();
    store.setCurrent(wc);
    await expect(store.update('missing', wc as never)).rejects.toThrow(/not the current/);
    await store.update('visp2', { ...store.list()[0], serverUrl: 'https://h/svn/moved' });
    expect(store.list()[0].serverUrl).toBe('https://h/svn/moved');
  });
  it('notifies listeners until disposed', () => {
    const { store } = make();
    let n = 0;
    const d = store.onDidChange(() => n++);
    store.notifyChanged();
    d.dispose();
    store.notifyChanged();
    expect(n).toBe(1);
  });
});

describe('working copy discovery', () => {
  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  const client = { info: async (p: string) => ({ path: p, url: 'svn://h/r/trunk', repositoryRoot: 'svn://h/r', repositoryUuid: 'u', revision: 1, nodeKind: 'dir' }) };
  it('finds the nearest folder with .svn above the focus folder', () => {
    const api = { hasSvnDir: (d: string) => d === path.resolve('/w/websites') };
    expect(findWcRootUp('/w/websites/visp2/App', api)).toBe(path.resolve('/w/websites'));
    expect(findWcRootUp('/elsewhere', api)).toBeUndefined();
  });
  it('names the repository after the opened folder and reads URL, root and UUID with svn info', async () => {
    const r = await discoverRepo(client, path.resolve('/w/websites/visp2'), silent, () => path.resolve('/w/websites'));
    expect(r).toEqual({ name: 'visp2', serverUrl: 'svn://h/r/trunk', localFolder: path.resolve('/w/websites'), repositoryRoot: 'svn://h/r', uuid: 'u' });
  });
  it('is undefined outside a working copy or when svn info fails', async () => {
    expect(await discoverRepo(client, '/x', silent, () => undefined)).toBeUndefined();
    expect(await discoverRepo(client, undefined, silent)).toBeUndefined();
    expect(await discoverRepo({ info: async () => { throw new Error('boom'); } }, '/x', silent, () => '/x')).toBeUndefined();
  });
});

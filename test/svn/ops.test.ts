/**
 * Live tests of add / ignore / override-update / update / commit (src/ops/svnOps.ts) against the local
 * servers. Uses its own scratch checkouts (F:\TrashCache\svn-ops-vitest), so the shared wc1 folders stay
 * untouched. Skipped when the servers or svn.exe are missing (python test-env/envctl.py reset).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll,beforeAll, describe, expect, it } from 'vitest';
import { rmTree, runDir } from './scratch';
import { IncomingService } from '../../src/incoming/service';
import { addIgnore, addPaths, commitPaths, deleteKeepLocal, overrideUpdate, readIgnore, removeIgnorePatterns, updatePaths } from '../../src/ops/svnOps';
import { RepoEntry } from '../../src/repos/model';
import { Credentials, SvnClient } from '../../src/svn/client';
import { findSvnExe } from '../../src/svn/discovery';
import { SvnLocator } from '../../src/svn/locator';

const BASE = runDir('svn-ops-vitest');
const ENVCTL = path.resolve(__dirname, '..', '..', 'test-env', 'envctl.py');
const TESTER = { username: 'tester', password: 'tester-pass' };

const CASES = [
  { proto: 'svn', repo: 'alpha', url: 'svn://127.0.0.1:13690/alpha/trunk', trust: false },
  { proto: 'https', repo: 'beta', url: 'https://127.0.0.1:18443/svn/beta/trunk', trust: true },
] as const;

const exe = findSvnExe().path;
const ports = [13690, 18443];
const up =
  spawnSync(process.execPath, ['-e', `const n=require('net');let ok=0;for(const p of ${JSON.stringify(ports)}){const s=n.connect({host:'127.0.0.1',port:p,timeout:1500});s.on('connect',()=>{s.destroy();if(++ok===${ports.length})process.exit(0)});s.on('timeout',()=>process.exit(1));s.on('error',()=>process.exit(1));}`], { timeout: 10_000 }).status === 0;
const enabled = !!exe && up;
if (!enabled) console.warn('[test:svn] ops tests SKIPPED: servers or svn.exe unavailable');

const silent = { info() {}, warn() {}, error() {}, debug() {} };

describe.skipIf(!enabled)('svn ops against local servers', () => {
  const client = new SvnClient(new SvnLocator(() => '', () => ({ path: exe, tried: [] })), undefined, silent, () => 60_000);

  afterAll(() => rmTree(BASE));
  beforeAll(() => {
    const appdata = path.join(BASE, 'appdata');
    fs.mkdirSync(appdata, { recursive: true });
    process.env.APPDATA = appdata;
    fs.mkdirSync(BASE, { recursive: true });
  });

  describe.each(CASES)('$repo over $proto', ({ proto, repo, url, trust }) => {
    const wc = path.join(BASE, `${repo}-${proto}`);
    const creds: Credentials = { ...TESTER, trustServerCert: trust };
    const entry: RepoEntry = { name: repo, serverUrl: url, localFolder: wc, ...TESTER, trustServerCert: trust };
    // The raw client has no credential provider here, so inject credentials through a thin wrapper.
    const withCreds = new Proxy(client, {
      get(t, k) {
        if (k === 'run') return (a: string[], o = {}) => t.run(a, { ...o, credentials: creds, repoName: undefined });
        if (k === 'status') return (p: string, o = {}) => t.status(p, { ...o, credentials: creds, repoName: undefined });
        return Reflect.get(t, k) as unknown;
      },
    }) as SvnClient;
    const c = { client: withCreds, repo: entry, tmpDir: path.join(BASE, 'tmp') };

    it('checks out', async () => {
      await withCreds.run(['checkout', '--', url, wc], {});
      expect(fs.existsSync(path.join(wc, '.svn'))).toBe(true);
    });

    it('adds a nested unversioned folder with --parents and honours depth', async () => {
      const dir = path.join(wc, 'ops-new', 'sub');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
      fs.writeFileSync(path.join(wc, 'ops-new', 'top.txt'), 't');
      await addPaths(c, [path.join(wc, 'ops-new')], 'files');
      let st = (await withCreds.status(wc)).entries;
      const item = (p: string) => st.find((e) => path.resolve(e.path) === path.resolve(p))?.item;
      expect(item(path.join(wc, 'ops-new'))).toBe('added');
      expect(item(path.join(wc, 'ops-new', 'top.txt'))).toBe('added');
      expect(item(path.join(wc, 'ops-new', 'sub'))).toBe('unversioned');
      // file deep inside an unversioned folder: --parents adds the folders on the way
      await addPaths(c, [path.join(dir, 'a.txt')]);
      st = (await withCreds.status(wc)).entries;
      expect(item(path.join(dir, 'a.txt'))).toBe('added');
      expect(item(dir)).toBe('added');
      // adding something already versioned is a no-op, not an error
      await addPaths(c, [path.join(wc, 'ops-new', 'top.txt')]);
    });

    it('merges svn:ignore without duplicates, handles removal and keep-local delete', async () => {
      const dir = path.join(wc, 'ops-new');
      fs.writeFileSync(path.join(dir, 'x.log'), 'log');
      fs.writeFileSync(path.join(dir, 'weird [1].tmp'), 'w');
      expect((await addIgnore(c, dir, ['*.log'])).added).toEqual(['*.log']);
      const again = await addIgnore(c, dir, ['*.log', 'weird \\[1\\].tmp']);
      expect(again.alreadyPresent).toEqual(['*.log']);
      expect(await readIgnore(c, dir)).toEqual(['*.log', 'weird \\[1\\].tmp']);
      const st = (await withCreds.status(wc)).entries.map((e) => path.basename(e.path));
      expect(st).not.toContain('x.log');
      expect(st).not.toContain('weird [1].tmp');
      expect(await removeIgnorePatterns(c, dir, ['*.log'])).toEqual(['weird \\[1\\].tmp']);
      expect(await removeIgnorePatterns(c, dir, ['weird \\[1\\].tmp'])).toEqual([]);
      expect(await readIgnore(c, dir)).toEqual([]);
      // versioned item: delete --keep-local leaves the file on disk
      await deleteKeepLocal(c, path.join(dir, 'top.txt'));
      expect(fs.existsSync(path.join(dir, 'top.txt'))).toBe(true);
      const e = (await withCreds.status(wc)).entries.find((x) => path.basename(x.path) === 'top.txt');
      expect(e?.item).toBe('unversioned');
    });

    it('commits the selected paths', async () => {
      const f = path.join(wc, `ops-commit-${Date.now()}.txt`);
      fs.writeFileSync(f, 'hello');
      await addPaths(c, [f]);
      const rev = await commitPaths(c, [f], 'ops test commit');
      expect(rev).toBeGreaterThan(0);
      expect((await withCreds.status(f)).entries.length).toBe(0);
      await deleteKeepLocal(c, f);
      expect(fs.existsSync(f)).toBe(true);
      expect((await withCreds.status(f)).entries[0].item).toBe('deleted');
    });

    it('Override and Update: needs incoming, discards local changes, keeps or removes unversioned files', async () => {
      const incoming = new IncomingService(withCreds, () => [entry]);
      await incoming.refresh({ remote: true });

      envctl('incoming', '--repo', repo, '--proto', proto, '--action', 'Modify');
      await incoming.refresh({ remote: true });
      const inc = pickModified(incoming.incomingUnder(wc));
      expect(inc.length).toBeGreaterThan(0);
      const target = inc[0].path;
      const original = fs.readFileSync(target, 'utf8');
      fs.writeFileSync(target, 'LOCAL EDIT\n' + original);
      const unv = path.join(wc, 'keep-me.txt');
      fs.writeFileSync(unv, 'unversioned');

      const res = await overrideUpdate(c, [target], { removeUnversioned: false });
      expect(res.conflicts).toEqual([]);
      expect(fs.readFileSync(target, 'utf8')).not.toContain('LOCAL EDIT');
      expect(fs.existsSync(unv)).toBe(true);
      await incoming.refresh({ remote: true });
      expect(incoming.hasIncoming(target)).toBe(false);

      // whole working copy, with a local modification, an added file and an incoming change
      envctl('incoming', '--repo', repo, '--proto', proto, '--action', 'Modify');
      await incoming.refresh({ remote: true });
      const t2 = pickModified(incoming.incomingUnder(wc))[0].path;
      fs.appendFileSync(t2, '\nLOCAL TWO\n');
      const added = path.join(wc, 'added-local.txt');
      fs.writeFileSync(added, 'x');
      await addPaths(c, [added]);
      const r2 = await overrideUpdate(c, [wc], { removeUnversioned: false });
      expect(r2.revision).toBeGreaterThan(0);
      expect(fs.readFileSync(t2, 'utf8')).not.toContain('LOCAL TWO');
      expect(fs.existsSync(unv)).toBe(true);
      expect(fs.existsSync(added)).toBe(true); // reverted add stays on disk as unversioned
      const after = (await withCreds.status(wc)).entries;
      expect(after.find((e) => path.basename(e.path) === 'added-local.txt')?.item).toBe('unversioned');

      // opt-in removal of unversioned files
      envctl('incoming', '--repo', repo, '--proto', proto, '--action', 'Modify');
      await incoming.refresh({ remote: true });
      await overrideUpdate(c, [wc], { removeUnversioned: true });
      expect(fs.existsSync(unv)).toBe(false);
      expect(fs.existsSync(added)).toBe(false);
      incoming.dispose();
    });

    it('plain update reports the new revision', async () => {
      envctl('incoming', '--repo', repo, '--proto', proto, '--action', 'Modify');
      const r = await updatePaths(c, [wc]);
      expect(r.revision).toBeGreaterThan(0);
    });
  });
});

// Other agents commit to the shared repos concurrently, so pick an existing modified file.
function pickModified<T extends { path: string; repoItem?: string }>(items: T[]): T[] {
  return items.filter((i) => i.repoItem === 'modified' && fs.existsSync(i.path) && fs.statSync(i.path).isFile());
}

function envctl(...args: string[]): string {
  return execFileSync('python', [ENVCTL, ...args], { encoding: 'utf8', timeout: 120_000, cwd: path.dirname(path.dirname(ENVCTL)) });
}

/** Live: an empty commit message goes through `-F <empty file>` and svn 1.14 accepts it (task 70). Own scratch under F:\TrashCache\svn-empty-msg. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { rmTree, runDir } from './scratch';
import { commitChangelist, executeCommit } from '../../src/commit/execute';
import { buildPlan } from '../../src/commit/selection';
import { parseLog } from '../../src/svn/xml';
import { RepoEntry } from '../../src/repos/model';
import { SvnClient } from '../../src/svn/client';
import { findSvnExe } from '../../src/svn/discovery';
import { SvnLocator } from '../../src/svn/locator';

const BASE = runDir('svn-empty-msg');
const URL = 'svn://127.0.0.1:13690/alpha/trunk';
const exe = findSvnExe().path;
const up = spawnSync(process.execPath, ['-e', "const s=require('net').connect({host:'127.0.0.1',port:13690,timeout:1500});s.on('connect',()=>process.exit(0));s.on('timeout',()=>process.exit(1));s.on('error',()=>process.exit(1));"], { timeout: 10_000 }).status === 0;
const silent = { info() {}, warn() {}, error() {}, debug() {} };

describe.skipIf(!exe || !up)('empty commit message', () => {
  const raw = new SvnClient(new SvnLocator(() => '', () => ({ path: exe, tried: [] })), undefined, silent, () => 60_000);
  const creds = { username: 'tester', password: 'tester-pass' };
  const client = new Proxy(raw, {
    get(t, k) {
      if (k === 'run') return (a: string[], o = {}) => t.run(a, { ...o, credentials: creds, repoName: undefined });
      return Reflect.get(t, k) as unknown;
    },
  }) as SvnClient;
  const wc = path.join(BASE, 'wc');
  const repo: RepoEntry = { name: 'alpha', serverUrl: URL, localFolder: wc, username: 'tester' };
  const c = { client, repo };
  const tmpDir = path.join(BASE, 'tmp');
  const dir = `esm-${Date.now().toString(36)}`;
  afterAll(() => rmTree(BASE));

  it('commits with an empty and a whitespace-only message', async () => {
    process.env.APPDATA = path.join(BASE, 'appdata');
    fs.mkdirSync(process.env.APPDATA, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    await client.run(['mkdir', '-m', 'empty-message test folder', '--', `${URL}/${dir}`], {});
    await client.run(['checkout', '--', `${URL}/${dir}`, wc], {});
    const f = path.join(wc, 'a.txt');
    fs.writeFileSync(f, 'one\n');
    await client.run(['add', '--', f], { cwd: wc });
    const entry = { repoName: 'alpha', path: f, item: 'unversioned', props: 'none', isDir: false };
    const r = await executeCommit(c, buildPlan('alpha', [entry], [f]), { message: '', tmpDir });
    expect(r.revision).toBeGreaterThan(0);
    const log = parseLog((await client.run(['log', '-r', String(r.revision), '--', URL], { cwd: wc, xml: true })).text);
    expect(log[0]?.message ?? '').toBe('');

    fs.appendFileSync(f, 'two\n');
    await client.run(['changelist', 'x', '--', f], { cwd: wc });
    const rev = await commitChangelist(c, 'x', { message: '   ', tmpDir });
    expect(rev).toBeGreaterThan(0);
  });
});

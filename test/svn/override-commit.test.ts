/**
 * Override and Commit engine against the real local svnserve (alpha, svn://). Each test checks out two fresh
 * working copies under F:\TrashCache\override-test: "user" (runs the override) and "mate" (the teammate who
 * creates the incoming changes). Skipped when the server or svn.exe is not available.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmTree, runDir } from './scratch';
import { ConflictsPresentError, OverrideError, NothingToOverrideError, SvnLike, collectLocalChanges, overrideAndCommit, restoreFromBackup } from '../../src/override/commitFlow';
import { listBackups, verifyBackup } from '../../src/override/backup';
import { Credentials, SvnClient, SvnRunOptions } from '../../src/svn/client';
import { findSvnExe } from '../../src/svn/discovery';
import { SvnError } from '../../src/svn/errors';
import { SvnLocator } from '../../src/svn/locator';

const SCRATCH = runDir('override-test');
const URL = 'svn://127.0.0.1:13690/alpha/trunk';
const CREDS: Credentials = { username: 'tester', password: 'tester-pass' };

function probe(port: number): boolean {
  const code = `const s=require('net').connect({host:'127.0.0.1',port:${port},timeout:1500});s.on('connect',()=>process.exit(0));s.on('timeout',()=>process.exit(1));s.on('error',()=>process.exit(1));`;
  return spawnSync(process.execPath, ['-e', code], { timeout: 10_000 }).status === 0;
}

const exe = findSvnExe().path;
const enabled = !!exe && probe(13690);
if (!enabled) console.warn(`[test:svn] override-commit SKIPPED: svn.exe=${!!exe} server=${enabled}`);

const client = new SvnClient(new SvnLocator(() => '', () => ({ path: exe, tried: [] })), undefined, undefined, () => 60_000);
const real: SvnLike = { run: (args, opts) => client.run(args, { credentials: CREDS, ...opts }) };
const sh = (args: string[], cwd: string, o: SvnRunOptions = {}) => real.run(args, { cwd, ...o });

interface Fixture {
  user: string;
  mate: string;
  backups: string;
  /** Folder (relative to trunk) created for this test. */
  dir: string;
}

let counter = 0;
const lines = (prefix: string, edit?: { n: number; text: string }): string =>
  Array.from({ length: 10 }, (_, i) => (edit && edit.n === i + 1 ? edit.text : `${prefix} line ${i + 1}`)).join('\n') + '\n';
const bytes = (seed: number, len = 2048): Buffer => Buffer.from(Array.from({ length: len }, (_, i) => (i * 31 + seed * 7 + (i >> 3)) & 0xff));

async function fixture(): Promise<Fixture> {
  const id = `${Date.now()}-${++counter}`;
  const base = path.join(SCRATCH, id);
  const f: Fixture = { user: path.join(base, 'user'), mate: path.join(base, 'mate'), backups: path.join(base, 'backups'), dir: `ov-${id}` };
  fs.mkdirSync(base, { recursive: true });
  await sh(['checkout', '--quiet', '--depth', 'empty', URL, f.mate], base);
  const d = path.join(f.mate, f.dir);
  fs.mkdirSync(path.join(d, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(d, 'a.txt'), lines('base'));
  fs.writeFileSync(path.join(d, 'b.txt'), lines('bee'));
  fs.writeFileSync(path.join(d, 'del.txt'), lines('del'));
  fs.writeFileSync(path.join(d, 'old.txt'), lines('old'));
  fs.writeFileSync(path.join(d, 'bin.dat'), bytes(1));
  fs.writeFileSync(path.join(d, 'sub', 'c.txt'), lines('sub'));
  await sh(['add', '--quiet', d], f.mate);
  await sh(['commit', '--quiet', '-m', 'override-test fixture', d], f.mate);
  await sh(['checkout', '--quiet', '--depth', 'empty', URL, f.user], base);
  await sh(['update', '--quiet', '--set-depth', 'infinity', path.join(f.user, f.dir)], f.user);
  return f;
}

const u = (f: Fixture, ...p: string[]): string => path.join(f.user, f.dir, ...p);
const m = (f: Fixture, ...p: string[]): string => path.join(f.mate, f.dir, ...p);
const serverCopy = async (f: Fixture, ...p: string[]): Promise<Buffer | undefined> => {
  await sh(['update', '--quiet'], f.mate);
  return fs.existsSync(m(f, ...p)) ? fs.readFileSync(m(f, ...p)) : undefined;
};
const mateCommit = async (f: Fixture, msg = 'incoming'): Promise<void> => void (await sh(['commit', '--quiet', '-m', msg, m(f)], f.mate));

const baseOpts = (f: Fixture, target: string, extra: Partial<Parameters<typeof overrideAndCommit>[0]> = {}): Parameters<typeof overrideAndCommit>[0] => ({
  svn: real,
  repoName: 'alpha',
  wcRoot: f.user,
  target,
  message: 'Override and Commit test',
  backupRoot: f.backups,
  keepBackups: 0,
  ...extra,
});

/** Wraps the real client so selected commands fail (until `times` is used up). */
function failing(sub: string, error: () => Error, times = Infinity): SvnLike & { calls: number } {
  const w = {
    calls: 0,
    run: async (args: readonly string[], opts?: SvnRunOptions) => {
      if (args[0] === sub && w.calls < times) {
        w.calls++;
        throw error();
      }
      return real.run(args, opts);
    },
  };
  return w;
}

/** Leaves the same wc_lock row a killed svn process would. */
function lockWc(wc: string): void {
  const py = "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute(\"insert into wc_lock (wc_id, local_dir_relpath, locked_levels) values (1,'',-1)\");c.commit()";
  expect(spawnSync('python', ['-c', py, path.join(wc, '.svn', 'wc.db')]).status).toBe(0);
}

const outOfDate = () => new SvnError('conflict', 'svn: E160024: File is out of date', 1, '', ['E160024']);

beforeAll(() => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const appdata = path.join(SCRATCH, 'appdata');
  fs.mkdirSync(appdata, { recursive: true });
  process.env.APPDATA = appdata;
});
afterAll(() => rmTree(SCRATCH));

describe.skipIf(!enabled)('Override and Commit engine (svn://)', { timeout: 240_000 }, () => {
  it('overrides an incoming modify of the same lines with the local version', async () => {
    const f = await fixture();
    fs.writeFileSync(m(f, 'a.txt'), lines('base', { n: 3, text: 'SERVER line 3' }));
    await mateCommit(f);
    fs.writeFileSync(u(f, 'a.txt'), lines('base', { n: 3, text: 'LOCAL line 3' }));
    const local = fs.readFileSync(u(f, 'a.txt'));

    const r = await overrideAndCommit(baseOpts(f, u(f, 'a.txt')));
    expect(r.revision).toBeGreaterThan(0);
    expect(r.backupKept).toBe(false);
    expect(fs.existsSync(r.backupDir)).toBe(false);
    expect((await serverCopy(f, 'a.txt'))!.equals(local)).toBe(true);
    expect(fs.readFileSync(u(f, 'a.txt')).equals(local)).toBe(true);
    const st = await sh(['status'], f.user);
    expect(st.text.trim()).toBe('');
  });

  it('commits a local add (file and new folder) while the server has other incoming changes', async () => {
    const f = await fixture();
    fs.writeFileSync(m(f, 'b.txt'), lines('bee', { n: 1, text: 'server edit' }));
    await mateCommit(f);
    fs.writeFileSync(u(f, 'new.txt'), 'brand new\n');
    fs.mkdirSync(u(f, 'newdir'));
    fs.writeFileSync(u(f, 'newdir', 'x.txt'), 'in new dir\n');
    await sh(['add', '--quiet', u(f, 'new.txt'), u(f, 'newdir')], f.user);

    const r = await overrideAndCommit(baseOpts(f, path.join(f.user, f.dir)));
    expect(r.entries.map((e) => e.state).sort()).toEqual(['added', 'added', 'added']);
    expect((await serverCopy(f, 'new.txt'))!.toString()).toBe('brand new\n');
    expect((await serverCopy(f, 'newdir', 'x.txt'))!.toString()).toBe('in new dir\n');
    expect((await serverCopy(f, 'b.txt'))!.toString()).toContain('server edit');
  });

  it('commits local deletes (svn delete and removed from disk) over an incoming change', async () => {
    const f = await fixture();
    fs.writeFileSync(m(f, 'del.txt'), lines('del', { n: 2, text: 'server touched' }));
    fs.writeFileSync(m(f, 'old.txt'), lines('old', { n: 2, text: 'server touched' }));
    await mateCommit(f);
    await sh(['delete', '--quiet', u(f, 'del.txt')], f.user);
    fs.rmSync(u(f, 'old.txt'));

    const r = await overrideAndCommit(baseOpts(f, path.join(f.user, f.dir)));
    expect(r.entries.every((e) => e.state === 'deleted')).toBe(true);
    expect(await serverCopy(f, 'del.txt')).toBeUndefined();
    expect(await serverCopy(f, 'old.txt')).toBeUndefined();
    expect(fs.existsSync(u(f, 'del.txt'))).toBe(false);
  });

  it('keeps binary content byte-exact', async () => {
    const f = await fixture();
    fs.writeFileSync(m(f, 'bin.dat'), bytes(2));
    await mateCommit(f);
    const mine = bytes(3, 5000);
    mine[0] = 0;
    mine[1] = 0xff;
    fs.writeFileSync(u(f, 'bin.dat'), mine);

    await overrideAndCommit(baseOpts(f, u(f, 'bin.dat')));
    expect((await serverCopy(f, 'bin.dat'))!.equals(mine)).toBe(true);
    expect(fs.readFileSync(u(f, 'bin.dat')).equals(mine)).toBe(true);
  });

  it('folder target: overrides everything beneath it and leaves changes outside the folder alone', async () => {
    const f = await fixture();
    fs.writeFileSync(m(f, 'a.txt'), lines('base', { n: 1, text: 'server a' }));
    fs.writeFileSync(m(f, 'sub', 'c.txt'), lines('sub', { n: 1, text: 'server c' }));
    await mateCommit(f);
    fs.writeFileSync(u(f, 'a.txt'), lines('base', { n: 1, text: 'local a' }));
    fs.writeFileSync(u(f, 'sub', 'c.txt'), lines('sub', { n: 1, text: 'local c' }));
    fs.writeFileSync(u(f, 'b.txt'), lines('bee', { n: 1, text: 'local b (outside target)' }));

    await overrideAndCommit(baseOpts(f, u(f, 'sub')));
    expect((await serverCopy(f, 'sub', 'c.txt'))!.toString()).toContain('local c');
    expect((await serverCopy(f, 'a.txt'))!.toString()).toContain('server a');
    expect(fs.readFileSync(u(f, 'a.txt'), 'utf8')).toContain('local a');
    expect(fs.readFileSync(u(f, 'b.txt'), 'utf8')).toContain('local b');
    const st = (await sh(['status'], f.user)).text;
    expect(st).toMatch(/M\s+.*a\.txt/);
  });

  it('whole working copy target', async () => {
    const f = await fixture();
    fs.writeFileSync(m(f, 'a.txt'), lines('base', { n: 5, text: 'server 5' }));
    fs.writeFileSync(m(f, 'b.txt'), lines('bee', { n: 5, text: 'server 5' }));
    await mateCommit(f);
    fs.writeFileSync(u(f, 'a.txt'), lines('base', { n: 5, text: 'local 5' }));
    fs.writeFileSync(u(f, 'sub', 'c.txt'), 'local sub\n');
    fs.writeFileSync(u(f, 'zz.txt'), 'added at wc level\n');
    await sh(['add', '--quiet', u(f, 'zz.txt')], f.user);

    const r = await overrideAndCommit(baseOpts(f, f.user));
    expect(r.revision).toBeDefined();
    expect((await serverCopy(f, 'a.txt'))!.toString()).toContain('local 5');
    expect((await serverCopy(f, 'sub', 'c.txt'))!.toString()).toBe('local sub\n');
    expect((await serverCopy(f, 'zz.txt'))!.toString()).toBe('added at wc level\n');
    expect((await sh(['status'], f.user)).text.trim()).toBe('');
  });

  it('replays a rename (move) with local edits while the server modified the old file', async () => {
    const f = await fixture();
    fs.writeFileSync(m(f, 'old.txt'), lines('old', { n: 4, text: 'server 4' }));
    await mateCommit(f);
    await sh(['move', '--quiet', u(f, 'old.txt'), u(f, 'renamed.txt')], f.user);
    fs.writeFileSync(u(f, 'renamed.txt'), lines('old', { n: 4, text: 'local 4 renamed' }));

    const r = await overrideAndCommit(baseOpts(f, path.join(f.user, f.dir)));
    expect(r.entries.map((e) => e.state).sort()).toEqual(['deleted', 'moved']);
    expect((await serverCopy(f, 'renamed.txt'))!.toString()).toContain('local 4 renamed');
    expect(await serverCopy(f, 'old.txt')).toBeUndefined();
  });

  it('re-adds a locally modified file that the server deleted (tree conflict resolved for local)', async () => {
    const f = await fixture();
    await sh(['delete', '--quiet', m(f, 'b.txt')], f.mate);
    await mateCommit(f, 'server deletes b');
    fs.writeFileSync(u(f, 'b.txt'), lines('bee', { n: 2, text: 'LOCAL only' }));

    const r = await overrideAndCommit(baseOpts(f, u(f, 'b.txt')));
    expect(r.revision).toBeDefined();
    expect((await serverCopy(f, 'b.txt'))!.toString()).toContain('LOCAL only');
    expect(fs.readFileSync(u(f, 'b.txt'), 'utf8')).toContain('LOCAL only');
  });

  it('keeps an incoming file add that collides with a local add: local content wins', async () => {
    const f = await fixture();
    fs.writeFileSync(m(f, 'clash.txt'), 'server clash\n');
    await sh(['add', '--quiet', m(f, 'clash.txt')], f.mate);
    await mateCommit(f);
    fs.writeFileSync(u(f, 'clash.txt'), 'local clash\n');
    await sh(['add', '--quiet', u(f, 'clash.txt')], f.user);

    await overrideAndCommit(baseOpts(f, u(f, 'clash.txt')));
    expect((await serverCopy(f, 'clash.txt'))!.toString()).toBe('local clash\n');
  });

  it('preserves locally set properties', async () => {
    const f = await fixture();
    fs.writeFileSync(m(f, 'a.txt'), lines('base', { n: 1, text: 'server' }));
    await mateCommit(f);
    fs.writeFileSync(u(f, 'a.txt'), lines('base', { n: 1, text: 'local' }));
    await sh(['propset', '--quiet', 'ov:custom', 'line one\nline two\n', u(f, 'a.txt')], f.user);

    await overrideAndCommit(baseOpts(f, u(f, 'a.txt')));
    await sh(['update', '--quiet'], f.mate);
    const pv = await sh(['propget', '--strict', 'ov:custom', m(f, 'a.txt')], f.mate);
    expect(pv.text).toBe('line one\nline two\n');
  });

  it('refuses a target without local changes and changes nothing', async () => {
    const f = await fixture();
    fs.writeFileSync(m(f, 'a.txt'), 'x\n');
    await mateCommit(f);
    await expect(overrideAndCommit(baseOpts(f, u(f, 'a.txt')))).rejects.toBeInstanceOf(NothingToOverrideError);
    expect(fs.existsSync(f.backups) ? fs.readdirSync(f.backups) : []).toEqual([]);
  });

  it('cancel before the destructive steps leaves the working copy untouched and removes the backup', async () => {
    const f = await fixture();
    fs.writeFileSync(u(f, 'a.txt'), 'local\n');
    const ac = new AbortController();
    const p = overrideAndCommit(baseOpts(f, u(f, 'a.txt'), { signal: ac.signal, progress: (msg) => msg.startsWith('Backing') && ac.abort() }));
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' });
    expect(fs.readFileSync(u(f, 'a.txt'), 'utf8')).toBe('local\n');
    expect(fs.readdirSync(f.backups)).toEqual([]);
  });

  it('keeps the backup and the local content when the commit keeps failing', async () => {
    const f = await fixture();
    fs.writeFileSync(m(f, 'a.txt'), lines('base', { n: 3, text: 'server' }));
    await mateCommit(f);
    fs.writeFileSync(u(f, 'a.txt'), 'local a\n');
    fs.writeFileSync(u(f, 'new.bin'), bytes(9));
    await sh(['add', '--quiet', u(f, 'new.bin')], f.user);
    const svn = failing('commit', () => new SvnError('unknown', 'svn: E165001: rejected by pre-commit hook', 1, '', ['E165001']));

    const err = (await overrideAndCommit(baseOpts(f, path.join(f.user, f.dir), { svn })).catch((e) => e)) as OverrideError;
    expect(err).toBeInstanceOf(OverrideError);
    expect(err.step).toBe('commit');
    expect(err.localRestored).toBe(true);
    expect(err.message).toContain(err.backupDir);
    expect(svn.calls).toBe(2);
    await verifyBackup(err.backupDir);
    expect(fs.readFileSync(u(f, 'a.txt'), 'utf8')).toBe('local a\n');
    expect(fs.readFileSync(u(f, 'new.bin')).equals(bytes(9))).toBe(true);
    expect((await sh(['status'], f.user)).text).toMatch(/A\s+.*new\.bin/);
    expect((await serverCopy(f, 'a.txt'))!.toString()).toContain('server');
  });

  it('retries once from the backup when the commit is rejected as out of date', async () => {
    const f = await fixture();
    fs.writeFileSync(u(f, 'a.txt'), 'local retry\n');
    const svn = failing('commit', outOfDate, 1);
    const r = await overrideAndCommit(baseOpts(f, u(f, 'a.txt'), { svn }));
    expect(r.attempts).toBe(2);
    expect((await serverCopy(f, 'a.txt'))!.toString()).toBe('local retry\n');
  });

  it('a failing update still ends with the local content back in the working copy and the backup kept', async () => {
    const f = await fixture();
    fs.writeFileSync(u(f, 'a.txt'), 'local survive\n');
    fs.writeFileSync(u(f, 'sub', 'c.txt'), 'local survive c\n');
    const svn = failing('update', () => new SvnError('offline', 'svn: E170013: Unable to connect', 1, '', ['E170013']));
    const err = (await overrideAndCommit(baseOpts(f, path.join(f.user, f.dir), { svn })).catch((e) => e)) as OverrideError;
    expect(err).toBeInstanceOf(OverrideError);
    expect(err.step).toBe('reset');
    expect(err.localRestored).toBe(true);
    expect(fs.readFileSync(u(f, 'a.txt'), 'utf8')).toBe('local survive\n');
    expect(fs.readFileSync(u(f, 'sub', 'c.txt'), 'utf8')).toBe('local survive c\n');
    expect((await listBackups(f.backups)).length).toBe(1);
  });

  it('restoreFromBackup puts a backed-up change set back after the local state was lost', async () => {
    const f = await fixture();
    fs.writeFileSync(u(f, 'a.txt'), 'precious a\n');
    fs.writeFileSync(u(f, 'bin.dat'), bytes(5, 3000));
    fs.writeFileSync(u(f, 'fresh.txt'), 'precious fresh\n');
    await sh(['add', '--quiet', u(f, 'fresh.txt')], f.user);
    await sh(['delete', '--quiet', u(f, 'del.txt')], f.user);
    const svn = failing('commit', () => new SvnError('unknown', 'nope', 1), 99);
    const err = (await overrideAndCommit(baseOpts(f, path.join(f.user, f.dir), { svn, maxAttempts: 1 })).catch((e) => e)) as OverrideError;

    await sh(['revert', '-R', '--quiet', f.user], f.user);
    fs.rmSync(u(f, 'fresh.txt'), { force: true });
    expect(fs.readFileSync(u(f, 'a.txt'), 'utf8')).not.toContain('precious');

    const res = await restoreFromBackup({ svn: real, repoName: 'alpha', wcRoot: f.user, backupDir: err.backupDir });
    expect(res.items).toBe(4);
    expect(fs.readFileSync(u(f, 'a.txt'), 'utf8')).toBe('precious a\n');
    expect(fs.readFileSync(u(f, 'bin.dat')).equals(bytes(5, 3000))).toBe(true);
    expect(fs.existsSync(u(f, 'del.txt'))).toBe(false);
    const st = (await sh(['status'], f.user)).text;
    expect(st).toMatch(/A\s+.*fresh\.txt/);
    expect(st).toMatch(/D\s+.*del\.txt/);
  });

  it('recovers from a locked working copy (svn cleanup + retry) in the flow and in restore', async () => {
    const f = await fixture();
    fs.writeFileSync(m(f, 'a.txt'), lines('base', { n: 1, text: 'server' }));
    await mateCommit(f);
    fs.writeFileSync(u(f, 'a.txt'), 'local locked\n');
    lockWc(f.user);
    const seen: Array<number | undefined> = [];
    const spy: SvnLike = { run: (args, opts) => (args[0] === 'revert' && seen.push(opts?.timeoutMs), real.run(args, opts)) };
    await overrideAndCommit(baseOpts(f, u(f, 'a.txt'), { svn: spy, timeoutMs: 123_000 }));
    expect(seen).toContain(123_000);
    expect((await serverCopy(f, 'a.txt'))!.toString()).toBe('local locked\n');

    fs.writeFileSync(u(f, 'b.txt'), 'precious b\n');
    const svn = failing('commit', () => new SvnError('unknown', 'nope', 1), 99);
    const err = (await overrideAndCommit(baseOpts(f, u(f, 'b.txt'), { svn, maxAttempts: 1 })).catch((e) => e)) as OverrideError;
    await sh(['revert', '--quiet', u(f, 'b.txt')], f.user);
    lockWc(f.user);
    await restoreFromBackup({ svn: real, repoName: 'alpha', wcRoot: f.user, backupDir: err.backupDir });
    expect(fs.readFileSync(u(f, 'b.txt'), 'utf8')).toBe('precious b\n');
  });

  it('refuses conflicted files and files with conflict markers before touching anything', async () => {
    const f = await fixture();
    fs.writeFileSync(m(f, 'a.txt'), lines('base', { n: 2, text: 'server 2' }));
    await mateCommit(f);
    fs.writeFileSync(u(f, 'a.txt'), lines('base', { n: 2, text: 'local 2' }));
    await sh(['update', '--quiet', '--accept', 'postpone'], f.user);
    expect((await sh(['status'], f.user)).text).toMatch(/^C\s+.*a\.txt/m);
    const e1 = (await overrideAndCommit(baseOpts(f, path.join(f.user, f.dir))).catch((e) => e)) as ConflictsPresentError;
    expect(e1).toBeInstanceOf(ConflictsPresentError);
    expect(e1.files).toContain(`${f.dir}/a.txt`);
    expect(e1.message).toContain('Resolve conflicts first');

    fs.writeFileSync(u(f, 'b.txt'), 'x\n<<<<<<< mine\nm\n=======\nt\n>>>>>>> theirs\n');
    const e2 = (await overrideAndCommit(baseOpts(f, u(f, 'b.txt'))).catch((e) => e)) as ConflictsPresentError;
    expect(e2).toBeInstanceOf(ConflictsPresentError);
    expect(e2.files).toEqual([`${f.dir}/b.txt`]);
    expect(fs.existsSync(f.backups) ? fs.readdirSync(f.backups) : []).toEqual([]);
    expect(fs.readFileSync(u(f, 'b.txt'), 'utf8')).toContain('<<<<<<<');
  });

  it('collectLocalChanges lists what the override would preserve', async () => {
    const f = await fixture();
    fs.writeFileSync(u(f, 'a.txt'), 'x\n');
    fs.writeFileSync(u(f, 'unversioned.txt'), 'ignored\n');
    const plan = await collectLocalChanges(real, 'alpha', f.user, f.user);
    expect(plan.map((p) => `${p.state}:${p.rel}`)).toEqual([`modified:${f.dir}/a.txt`]);
  });
});

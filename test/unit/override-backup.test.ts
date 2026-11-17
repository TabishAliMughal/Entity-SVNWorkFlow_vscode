import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackupVerifyError, createBackup, describeEntry, listBackups, markCompleted, planEntries, pruneCommitted, timestampName, toAbs, toRel, verifyBackup } from '../../src/override/backup';
import { StatusEntry } from '../../src/svn/xml';
import { RepoLocks } from '../../src/override/commitLocks';

const ROOT = path.join((fs.existsSync('F:\\TrashCache') ? 'F:\\TrashCache' : os.tmpdir()), 'override-unit');
const WC = path.join(ROOT, 'wc');

const st = (p: string, item: string, extra: Partial<StatusEntry> = {}): StatusEntry => ({ path: path.join(WC, p), item, props: 'none', wcLocked: false, ...extra });

beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(WC, 'dir', 'inner'), { recursive: true });
  fs.writeFileSync(path.join(WC, 'a.txt'), 'hello\r\nworld\r\n');
  fs.writeFileSync(path.join(WC, 'bin.dat'), Buffer.from([0, 1, 2, 255, 254, 0, 13, 10]));
  fs.writeFileSync(path.join(WC, 'dir', 'inner', 'x.txt'), 'x');
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const kindOf = (abs: string) => (fs.existsSync(abs) ? (fs.statSync(abs).isDirectory() ? 'dir' : 'file') : 'none') as 'file' | 'dir' | 'none';

describe('planEntries', () => {
  it('maps svn statuses to backup states and skips unversioned/normal', () => {
    const plan = planEntries(
      [
        st('a.txt', 'modified'),
        st('b.txt', 'missing'),
        st('c.txt', 'deleted', { movedTo: path.join(WC, 'd.txt') }),
        st('d.txt', 'added', { copied: true, movedFrom: path.join(WC, 'c.txt') }),
        st('new.txt', 'unversioned'),
        st('ok.txt', 'normal'),
        st('dir', 'normal', { props: 'modified' }),
        st('bin.dat', 'replaced'),
        st('ign', 'ignored'),
      ],
      WC,
      kindOf,
    );
    expect(plan.map((p) => `${p.state}:${p.rel}`)).toEqual(['modified:a.txt', 'deleted:b.txt', 'modified:bin.dat', 'deleted:c.txt', 'moved:d.txt', 'modified:dir']);
    const moved = plan.find((p) => p.state === 'moved')!;
    expect(moved.movedFrom).toBe('c.txt');
    expect(plan.find((p) => p.rel === 'c.txt')!.movedTo).toBe('d.txt');
    expect(plan.find((p) => p.rel === 'dir')!.kind).toBe('dir');
  });

  it('marks copied folders and moved folders as recursive; plain added folders are not', () => {
    const plan = planEntries([st('dir', 'added', { copied: true }), st('dir/inner', 'added')], WC, kindOf);
    expect(plan.find((p) => p.rel === 'dir')!.recursive).toBe(true);
    expect(plan.find((p) => p.rel === 'dir/inner')!.recursive).toBeUndefined();
  });

  it('ignores paths outside the working copy and sorts parents first', () => {
    const plan = planEntries([st('dir/inner/x.txt', 'modified'), { ...st('a.txt', 'modified'), path: 'F:\\elsewhere\\o.txt' }, st('dir', 'normal', { props: 'conflicted' })], WC, kindOf);
    expect(plan.map((p) => p.rel)).toEqual(['dir', 'dir/inner/x.txt']);
  });

  it('describes entries and paths', () => {
    expect(describeEntry({ rel: 'x/y.txt', state: 'moved', svnStatus: 'added', props: 'none', kind: 'file', movedFrom: 'x/z.txt' })).toBe('R  x/y.txt  (from x/z.txt)');
    expect(toRel(WC, toAbs(WC, 'dir/inner/x.txt'))).toBe('dir/inner/x.txt');
    expect(timestampName(new Date(2026, 10, 16, 9, 8, 7), 'My Repo/α')).toBe('20261116-090807-My_Repo_');
  });
});

describe('createBackup / verifyBackup', () => {
  it('copies content byte-exact, hashes it, writes a manifest', async () => {
    const plan = planEntries([st('a.txt', 'modified'), st('bin.dat', 'modified'), st('gone.txt', 'deleted'), st('dir', 'added', { copied: true })], WC, kindOf);
    const { dir, manifest } = await createBackup({
      backupRoot: path.join(ROOT, 'backups'),
      repoName: 'alpha',
      wcRoot: WC,
      target: WC,
      message: 'msg \u00e9',
      entries: plan,
      propValues: new Map([['a.txt', { 'ov:p': 'AQID' }]]),
      now: new Date(2026, 0, 2, 3, 4, 5),
    });
    expect(path.basename(dir)).toBe('20260102-030405-alpha');
    expect(fs.readFileSync(path.join(dir, 'files', 'bin.dat')).equals(fs.readFileSync(path.join(WC, 'bin.dat')))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'files', 'a.txt'), 'latin1')).toBe('hello\r\nworld\r\n');
    expect(fs.readFileSync(path.join(dir, 'files', 'dir', 'inner', 'x.txt'), 'utf8')).toBe('x');
    expect(manifest.entries.find((e) => e.rel === 'gone.txt')!.files).toBeUndefined();
    expect(manifest.entries.find((e) => e.rel === 'a.txt')!.propValues).toEqual({ 'ov:p': 'AQID' });
    expect(manifest.targetRel).toBe('');
    expect(fs.readFileSync(path.join(dir, 'message.txt'), 'utf8')).toBe('msg \u00e9');
    await verifyBackup(dir);

    fs.appendFileSync(path.join(dir, 'files', 'a.txt'), 'tamper');
    await expect(verifyBackup(dir)).rejects.toBeInstanceOf(BackupVerifyError);
  });

  it('uses a unique folder when the name is taken and fails cleanly when a source disappears', async () => {
    const root = path.join(ROOT, 'backups2');
    const opts = { backupRoot: root, repoName: 'r', wcRoot: WC, target: WC, message: 'm', now: new Date(2026, 0, 1) };
    const plan = planEntries([st('a.txt', 'modified')], WC, kindOf);
    const a = await createBackup({ ...opts, entries: plan });
    const b = await createBackup({ ...opts, entries: plan });
    expect(a.dir).not.toBe(b.dir);
    const missing = planEntries([st('a.txt', 'modified')], WC, () => 'file');
    missing[0].rel = 'nope.txt';
    await expect(createBackup({ ...opts, entries: missing })).rejects.toBeInstanceOf(BackupVerifyError);
    expect(fs.readdirSync(root).length).toBe(2);
  });

  it('lists newest first and prunes only committed backups beyond N', async () => {
    const root = path.join(ROOT, 'backups3');
    const plan = planEntries([st('a.txt', 'modified')], WC, kindOf);
    const dirs: string[] = [];
    for (let i = 1; i <= 4; i++) {
      dirs.push((await createBackup({ backupRoot: root, repoName: 'p', wcRoot: WC, target: WC, message: 'm', entries: plan, now: new Date(2026, 0, i) })).dir);
    }
    await markCompleted(dirs[0], 1, new Date(2026, 0, 1));
    await markCompleted(dirs[1], 2, new Date(2026, 0, 2));
    await markCompleted(dirs[2], 3, new Date(2026, 0, 3));
    expect((await listBackups(root)).map((b) => b.dir)).toEqual([dirs[3], dirs[2], dirs[1], dirs[0]]);
    const removed = await pruneCommitted(root, 2);
    expect(removed).toEqual([dirs[0]]);
    expect(fs.existsSync(dirs[3])).toBe(true);
    await pruneCommitted(root, 0);
    expect((await listBackups(root)).map((b) => b.dir)).toEqual([dirs[3]]);
  });
});

describe('RepoLocks', () => {
  it('allows one holder per repo (case-insensitive) and releases', () => {
    const l = new RepoLocks();
    const r = l.tryAcquire('Alpha')!;
    expect(r).toBeTypeOf('function');
    expect(l.tryAcquire('alpha')).toBeUndefined();
    expect(l.tryAcquire('beta')).toBeTypeOf('function');
    r();
    expect(l.isBusy('alpha')).toBe(false);
    expect(l.tryAcquire('alpha')).toBeTypeOf('function');
  });
});

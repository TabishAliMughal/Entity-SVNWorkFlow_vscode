import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { validateChangelistName } from '../../src/changelist/model';
import { CertGuard } from '../../src/repos/certGuard';
import type { RepoEntry } from '../../src/repos/model';
import { MANIFEST_NAME, readManifest, toAbs } from '../../src/override/backup';
import { cleanTmp, staleBackups } from '../../src/override/housekeeping';
import { unsafePatchTargets } from '../../src/patch/model';
import { parseShelfMeta } from '../../src/shelve/model';
import { describePeerCert, normalizeFingerprint, parseSvnCertificateText, pinState, type CertInfo } from '../../src/svn/certificate';
import { MAX_PATH_KEYS, capPathKeys } from '../../src/util/pathKeys';
import { assertSafeRel, assertUnder, isSafeRel } from '../../src/util/safePath';
import { encodeSvnUrl, joinSvnUrl } from '../../src/util/svnUrl';
import { RepoBusyError, runExclusive } from '../../src/wc/lock';
import { RepoLocks } from '../../src/override/commitLocks';
import { checkServerUrl } from '../../src/repos/model';
import { resolveSvnUrl } from '../../src/wc/model';
import { refUrl } from '../../src/branch/model';

const scratchBase = fs.existsSync('F:\\TrashCache') ? 'F:\\TrashCache' : os.tmpdir();
const scratch = fs.mkdtempSync(path.join(scratchBase, 'security-unit-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const nullLog = { info() {}, warn() {}, error() {}, debug() {} };

describe('certificate pinning', () => {
  const info = (fp: string): CertInfo => ({ host: 'h', port: 443, fingerprint: fp, issuer: 'CN=ca', subject: 'CN=h', validFrom: '', validTo: '', hostnameMatches: true });
  const repo = (over: Partial<RepoEntry> = {}): RepoEntry => ({ name: 'r', serverUrl: 'https://h/svn/r', localFolder: 'C:\\wc', trustServerCert: true, ...over });

  it('normalises fingerprints and compares states', () => {
    expect(normalizeFingerprint('aa bb:cc-dd')).toBe('AA:BB:CC:DD');
    expect(pinState(undefined, 'AA')).toBe('unpinned');
    expect(pinState('aa:bb', 'AA:BB')).toBe('match');
    expect(pinState('AA:BB', 'AA:BC')).toBe('changed');
  });

  it('parses the fingerprint, issuer and host name from svn certificate text', () => {
    const t = ' - Hostname: svn.corp\n - Valid from Jan 1 2024 until Jan 1 2030\n - Issuer: Corp CA, Corp, DE\n - Fingerprint: ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01\n';
    const p = parseSvnCertificateText(t);
    expect(p.fingerprint).toBe('AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01');
    expect(p.issuer).toBe('Corp CA, Corp, DE');
    expect(p.subject).toBe('svn.corp');
  });

  it('describes a peer certificate and flags a host name mismatch', () => {
    const c = describePeerCert('other.example', 443, { fingerprint: 'aa:bb', issuer: { CN: 'ca' }, subject: { CN: 'svn.corp' }, valid_from: 'a', valid_to: 'b', subjectaltname: 'DNS:svn.corp' });
    expect(c).toMatchObject({ fingerprint: 'AA:BB', issuer: 'CN=ca', subject: 'CN=svn.corp', hostnameMatches: false });
  });

  function guard(r: RepoEntry, live: string, confirm: boolean) {
    const entry = { ...r };
    const confirmChanged = vi.fn(async () => confirm);
    const repin = vi.fn(async (_n: string, fp: string) => void (entry.trustedCertFingerprint = fp));
    const probe = vi.fn(async () => info(live));
    const g = new CertGuard({ findRepo: () => entry, repin, confirmChanged, logger: nullLog, probe, ttlMs: 0 });
    return { g, confirmChanged, repin, probe };
  }

  it('applies the trust flag only to https repositories', async () => {
    const { g } = guard(repo({ serverUrl: 'svn://h/r' }), 'AA', true);
    expect(await g.allow('r', ['update'])).toBe(false);
    expect(await g.allow(undefined, ['checkout', '--', 'svn://h/r', 'C:\\x'])).toBe(false);
    expect(await g.allow(undefined, ['checkout', '--', 'https://h/r', 'C:\\x'])).toBe(true);
  });

  it('allows an unpinned (legacy) entry and a matching pin without prompting', async () => {
    expect(await guard(repo(), 'AA', true).g.allow('r', [])).toBe(true);
    const m = guard(repo({ trustedCertFingerprint: 'aa' }), 'AA', true);
    expect(await m.g.allow('r', [])).toBe(true);
    expect(m.confirmChanged).not.toHaveBeenCalled();
  });

  it('a changed certificate needs the modal confirmation; refusing drops the trust flag and is remembered', async () => {
    const t = guard(repo({ trustedCertFingerprint: 'AA' }), 'BB', false);
    expect(await t.g.allow('r', [])).toBe(false);
    expect(await t.g.allow('r', [])).toBe(false);
    expect(t.confirmChanged).toHaveBeenCalledTimes(1);
    expect(t.repin).not.toHaveBeenCalled();
  });

  it('re-confirming stores the new fingerprint', async () => {
    const t = guard(repo({ trustedCertFingerprint: 'AA' }), 'BB', true);
    expect(await t.g.allow('r', [])).toBe(true);
    expect(t.repin).toHaveBeenCalledWith('r', 'BB');
  });

  it('fails closed when a pinned certificate cannot be read', async () => {
    const entry = repo({ trustedCertFingerprint: 'AA' });
    const g = new CertGuard({ findRepo: () => entry, repin: async () => {}, confirmChanged: async () => true, logger: nullLog, probe: async () => Promise.reject(new Error('down')) });
    expect(await g.allow('r', [])).toBe(false);
  });
});

describe('path safety (L1, L2, L4)', () => {
  it('isSafeRel rejects absolute, drive, stream, backslash and dot-dot paths', () => {
    for (const bad of ['/etc/passwd', 'C:/x', 'C:x', '..', '../x', 'a/../b', 'a//b', 'a\\b', 'a/./b', 'file.txt:stream', '', 'a\0b', 5]) expect(isSafeRel(bad)).toBe(false);
    for (const ok of ['a', 'a/b/c.txt', 'dir with space/f@1.txt', '.hidden/x']) expect(isSafeRel(ok)).toBe(true);
    expect(isSafeRel('', true)).toBe(true);
    expect(() => assertSafeRel('../x', 'path')).toThrow(/Unsafe path/);
  });

  it('assertUnder accepts the root and children only', () => {
    const root = path.join(scratch, 'wc');
    expect(assertUnder(path.join(root, 'a', 'b'), root)).toBeTruthy();
    expect(assertUnder(root, root)).toBe(root);
    expect(() => assertUnder(path.join(root, '..', 'x'), root)).toThrow(/outside/);
    expect(() => assertUnder(root + '-sibling', root)).toThrow(/outside/);
    expect(() => toAbs(root, '../x')).toThrow(/outside/);
  });

  const writeManifest = (dir: string, m: unknown): Promise<void> => fs.promises.mkdir(dir, { recursive: true }).then(() => fs.promises.writeFile(path.join(dir, MANIFEST_NAME), JSON.stringify(m)));
  const manifest = (entry: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ version: 1, createdAt: '2020-01-01T00:00:00Z', repoName: 'r', wcRoot: 'C:\\wc', targetRel: '', message: '', entries: [{ rel: 'a.txt', state: 'modified', svnStatus: 'modified', props: 'none', kind: 'file', ...entry }], ...extra });

  it('readManifest rejects tampered paths', async () => {
    const ok = path.join(scratch, 'm-ok');
    await writeManifest(ok, manifest({ files: [{ rel: 'a.txt', size: 1, sha256: 'x' }] }));
    expect((await readManifest(ok)).entries).toHaveLength(1);
    const cases: Array<Record<string, unknown>> = [{ rel: '../evil' }, { rel: 'C:/evil' }, { movedFrom: '/abs' }, { movedTo: 'a/../../b' }, { files: [{ rel: '..\\x', size: 1, sha256: 'x' }] }];
    let i = 0;
    for (const c of cases) {
      const d = path.join(scratch, `m-bad-${i++}`);
      await writeManifest(d, manifest(c));
      await expect(readManifest(d)).rejects.toThrow(/not trusted/);
    }
    const d = path.join(scratch, 'm-bad-target');
    await writeManifest(d, manifest({}, { targetRel: '../up' }));
    await expect(readManifest(d)).rejects.toThrow(/not trusted/);
  });

  it('parseShelfMeta rejects absolute or .. file paths', () => {
    const meta = (p: string) => JSON.stringify({ format: 1, name: 's', files: [{ path: p, status: 'modified', binary: false }] });
    expect(parseShelfMeta(meta('src/a.txt')).files[0].path).toBe('src/a.txt');
    for (const bad of ['../a', '/a', 'C:/a', 'a/../../b']) expect(() => parseShelfMeta(meta(bad))).toThrow(/Unsafe/);
  });
});

describe('unsafePatchTargets (L3)', () => {
  it('finds absolute and .. targets in svn and git style headers', () => {
    const patch = [
      'Index: ok.txt',
      '--- ok.txt\t(revision 1)',
      '+++ ok.txt\t(working copy)',
      'Index: ../../outside.txt',
      '--- /etc/passwd\t(revision 1)',
      '+++ C:\\Windows\\x.txt\t(working copy)',
      'diff --git a/fine.txt b/fine.txt',
      'rename from sub/../../up.txt',
      '--- /dev/null',
      '+++ b/new.txt',
    ].join('\n');
    expect(unsafePatchTargets(patch).sort()).toEqual(['../../outside.txt', '/etc/passwd', 'C:\\Windows\\x.txt', 'sub/../../up.txt'].sort());
    expect(unsafePatchTargets('Index: a/b.txt\n--- a/b.txt\n+++ a/b.txt\n')).toEqual([]);
    expect(unsafePatchTargets('diff --git a/../x b/../x\n')).toEqual(['a/../x', 'b/../x']);
  });
});

describe('changelist names (L6)', () => {
  it('rejects wildcard characters', () => {
    expect(validateChangelistName('feature*')).toMatch(/wildcard/);
    expect(validateChangelistName('what?')).toMatch(/wildcard/);
    expect(validateChangelistName('ok name')).toBeUndefined();
  });
});

describe('context key cap', () => {
  it('keeps everything below the cap, truncates above and warns once', () => {
    const warn = vi.fn();
    const log = { ...nullLog, warn };
    expect(MAX_PATH_KEYS).toBeGreaterThanOrEqual(200_000);
    const small = ['a', 'b'];
    expect(capPathKeys('k1', small, log)).toBe(small);
    const big = Array.from({ length: 7 }, (_, i) => String(i));
    expect(capPathKeys('k2', big, log, 5)).toHaveLength(5);
    capPathKeys('k2', big, log, 5);
    expect(warn).toHaveBeenCalledTimes(1);
    capPathKeys('k2', small, log, 5);
    capPathKeys('k2', big, log, 5);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('repo busy refusal (testing finding 1)', () => {
  it('runExclusive refuses while the repo is busy and releases afterwards, also on error', async () => {
    const locks = new RepoLocks();
    const release = locks.tryAcquire('Alpha') as () => void;
    const fn = vi.fn(async () => 'done');
    await expect(runExclusive('alpha', fn, locks)).rejects.toBeInstanceOf(RepoBusyError);
    expect(fn).not.toHaveBeenCalled();
    release();
    expect(await runExclusive('alpha', fn, locks)).toBe('done');
    expect(locks.isBusy('alpha')).toBe(false);
    await expect(runExclusive('alpha', async () => Promise.reject(new Error('x')), locks)).rejects.toThrow('x');
    expect(locks.isBusy('alpha')).toBe(false);
  });
});

describe('URL encoding (testing finding 7)', () => {
  it('encodes spaces, non-ASCII, specials and @ in the path; keeps escapes and a trailing peg', () => {
    expect(encodeSvnUrl('https://h/svn/r/branches/my branch')).toBe('https://h/svn/r/branches/my%20branch');
    expect(encodeSvnUrl('svn://h/r/bränch')).toBe('svn://h/r/br%C3%A4nch');
    expect(encodeSvnUrl('svn://h/r/a%20b')).toBe('svn://h/r/a%20b');
    expect(encodeSvnUrl('svn://h/r/100%')).toBe('svn://h/r/100%25');
    expect(encodeSvnUrl('svn://h/r/a#b?c')).toBe('svn://h/r/a%23b%3Fc');
    expect(encodeSvnUrl('svn://h/r/user@site/f')).toBe('svn://h/r/user%40site/f');
    expect(encodeSvnUrl('svn://h/r/f.txt@12')).toBe('svn://h/r/f.txt@12');
    expect(encodeSvnUrl('svn://h/r/f.txt@HEAD')).toBe('svn://h/r/f.txt@HEAD');
    expect(encodeSvnUrl('svn://h/r/😀')).toBe('svn://h/r/%F0%9F%98%80');
  });

  it('joinSvnUrl encodes each decoded segment', () => {
    expect(joinSvnUrl('svn://h/r/', 'branches', 'my branch')).toBe('svn://h/r/branches/my%20branch');
    expect(joinSvnUrl('svn://h/r', 'feature/a b', 'ü')).toBe('svn://h/r/feature/a%20b/%C3%BC');
  });

  it('checkServerUrl, resolveSvnUrl and refUrl produce encoded URLs', () => {
    expect(checkServerUrl('https://h/svn/my repo').url).toBe('https://h/svn/my%20repo');
    expect(resolveSvnUrl('^/branches/a b', 'svn://h/r')).toBe('svn://h/r/branches/a%20b');
    expect(resolveSvnUrl('svn://H/r/x y', 'svn://h/r')).toBe('svn://h/r/x%20y');
    const layout = { root: 'svn://h/r', base: 'svn://h/r', trunk: 'svn://h/r/trunk', branches: 'svn://h/r/branches', tags: 'svn://h/r/tags', kind: 'other' as const };
    expect(refUrl(layout as never, 'branch', 'feature/my branch')).toBe('svn://h/r/branches/feature/my%20branch');
  });
});

describe('housekeeping (M4)', () => {
  it('cleanTmp removes old files and keeps recent ones', async () => {
    const dir = path.join(scratch, 'tmp');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'old.tmp'), 'secret');
    fs.writeFileSync(path.join(dir, 'new.tmp'), 'x');
    const old = new Date(Date.now() - 3 * 3600_000);
    fs.utimesSync(path.join(dir, 'old.tmp'), old, old);
    expect(await cleanTmp(dir)).toBe(1);
    expect(fs.readdirSync(dir)).toEqual(['new.tmp']);
    expect(await cleanTmp(path.join(scratch, 'missing'))).toBe(0);
  });

  it('staleBackups lists unfinished backups older than N days only', async () => {
    const root = path.join(scratch, 'backups');
    const mk = (name: string, createdAt: string, completed?: object) => {
      const d = path.join(root, name);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, MANIFEST_NAME), JSON.stringify({ version: 1, createdAt, repoName: 'r', wcRoot: 'C:\\wc', targetRel: '', message: '', entries: [], completed }));
    };
    const now = Date.parse('2026-06-30T00:00:00Z');
    mk('old-failed', '2026-01-01T00:00:00Z');
    mk('old-done', '2026-01-01T00:00:00Z', { at: '2026-01-01T00:00:00Z' });
    mk('recent-failed', '2026-06-20T00:00:00Z');
    expect((await staleBackups(root, 30, now)).map((b) => path.basename(b.dir))).toEqual(['old-failed']);
    expect(await staleBackups(root, 0, now)).toEqual([]);
  });
});

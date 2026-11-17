/**
 * Integration tests against the local servers from test-env/envctl.py. Runs the real
 * SvnClient/runner in plain Node. Skipped entirely when the servers are not up
 * (start them with `python test-env/envctl.py reset`).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Credentials, SvnClient } from '../../src/svn/client';
import { findSvnExe } from '../../src/svn/discovery';
import { SvnError } from '../../src/svn/errors';
import { SvnLocator } from '../../src/svn/locator';
import { Logger } from '../../src/util/logger';

const ROOT = 'F:\\TrashCache\\svn-test-env';
const SCRATCH = 'F:\\TrashCache';
const ENVCTL = path.resolve(__dirname, '..', '..', 'test-env', 'envctl.py');

const PROTOS = {
  svn: { port: 13690, url: (r: string) => `svn://127.0.0.1:13690/${r}` },
  http: { port: 18080, url: (r: string) => `http://127.0.0.1:18080/svn/${r}` },
  https: { port: 18443, url: (r: string) => `https://127.0.0.1:18443/svn/${r}` },
} as const;
type Proto = keyof typeof PROTOS;
type RepoName = 'alpha' | 'beta';

const TESTER = { username: 'tester', password: 'tester-pass' };
const READER = { username: 'reader', password: 'reader-pass' };
const wc = (repo: RepoName, proto: Proto, n: 1 | 2 = 1): string => path.join(ROOT, 'wc', `${repo}-${proto}`, `wc${n}`);

function probeAll(ports: number[]): boolean {
  const code = `const n=require('net');let ok=0;const ports=${JSON.stringify(ports)};` +
    `for(const p of ports){const s=n.connect({host:'127.0.0.1',port:p,timeout:1500});` +
    `s.on('connect',()=>{s.destroy();if(++ok===ports.length)process.exit(0)});` +
    `s.on('timeout',()=>process.exit(1));s.on('error',()=>process.exit(1));}`;
  return spawnSync(process.execPath, ['-e', code], { timeout: 10_000 }).status === 0;
}

const exe = findSvnExe().path;
const upAll = probeAll(Object.values(PROTOS).map((p) => p.port));
const wcsExist = fs.existsSync(wc('alpha', 'svn')) && fs.existsSync(wc('beta', 'https'));
const enabled = !!exe && upAll && wcsExist;
if (!enabled) {
  console.warn(`[test:svn] SKIPPED: svn.exe=${!!exe} servers=${upAll} workingCopies=${wcsExist}. Run: python test-env/envctl.py reset`);
}

const logLines: string[] = [];
const logger: Logger = {
  info: (m) => void logLines.push(m),
  warn: (m) => void logLines.push(m),
  error: (m) => void logLines.push(m),
  debug: (m) => void logLines.push(m),
};

function makeClient(timeoutMs = 60_000): SvnClient {
  return new SvnClient(new SvnLocator(() => '', () => ({ path: exe, tried: [] })), undefined, logger, () => timeoutMs);
}

async function expectKind(p: Promise<unknown>, kind: string): Promise<SvnError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(SvnError);
    expect((e as SvnError).kind, `${(e as SvnError).message} | ${(e as SvnError).stderr}`).toBe(kind);
    return e as SvnError;
  }
  throw new Error(`expected SvnError(${kind}), call succeeded`);
}

function envctl(...args: string[]): string {
  return execFileSync('python', [ENVCTL, ...args], { encoding: 'utf8', timeout: 120_000, cwd: path.dirname(path.dirname(ENVCTL)) });
}

describe.skipIf(!enabled)('svn integration (local test servers)', () => {
  const client = makeClient();

  beforeAll(() => {
    // Keep the user's real %APPDATA%\Subversion (accepted certs, auth cache) out of the picture.
    const appdata = path.join(SCRATCH, 'svn-vitest-appdata');
    fs.rmSync(appdata, { recursive: true, force: true });
    fs.mkdirSync(appdata, { recursive: true });
    process.env.APPDATA = appdata;
  });

  describe.each(['svn', 'http', 'https'] as Proto[])('%s://', (proto) => {
    const creds: Credentials = { ...TESTER, trustServerCert: proto === 'https' };

    it('info on a working copy and on the server URL', async () => {
      const local = await client.info(wc('alpha', proto), { credentials: creds });
      expect(local.url).toBe(`${PROTOS[proto].url('alpha')}/trunk`);
      expect(local.repositoryRoot).toBe(PROTOS[proto].url('alpha'));
      expect(local.nodeKind).toBe('dir');
      expect(local.revision).toBeGreaterThan(0);
      const remote = await client.info(`${PROTOS[proto].url('alpha')}/trunk`, { credentials: creds });
      expect(remote.repositoryUuid).toBe(local.repositoryUuid);
    });

    it('info works for the second repo and a different uuid (multi-repo)', async () => {
      const a = await client.info(wc('alpha', proto), { credentials: creds });
      const b = await client.info(wc('beta', proto), { credentials: creds });
      expect(b.url).toBe(`${PROTOS[proto].url('beta')}/trunk`);
      expect(b.repositoryUuid).not.toBe(a.repositoryUuid);
    });

    it('local status parses and shows a modification', async () => {
      const folder = wc('beta', proto);
      const file = path.join(folder, 'README.md');
      const original = fs.readFileSync(file);
      try {
        fs.appendFileSync(file, '\nlocal edit\n');
        const unv = path.join(folder, `unversioned-${Date.now()}.txt`);
        fs.writeFileSync(unv, 'x');
        try {
          const { entries } = await client.status(folder, { credentials: creds });
          const byName = (n: string) => entries.find((e) => path.basename(e.path) === n);
          expect(byName('README.md')?.item).toBe('modified');
          expect(byName(path.basename(unv))?.item).toBe('unversioned');
          expect(byName('README.md')?.repoItem).toBeUndefined();
        } finally {
          fs.rmSync(unv, { force: true });
        }
      } finally {
        fs.writeFileSync(file, original);
      }
    });

    it('wrong password gives an auth error', async () => {
      await expectKind(client.info(wc('alpha', proto), { credentials: { ...creds, password: 'definitely-wrong' } }).then(() => client.status(wc('alpha', proto), { showUpdates: true, credentials: { ...creds, password: 'definitely-wrong' } })), 'auth');
    });
  });

  describe('https certificate handling', () => {
    const url = `${PROTOS.https.url('alpha')}/trunk`;

    it('fails with a certificate error when trustServerCert is off', async () => {
      const e = await expectKind(client.info(url, { credentials: { ...TESTER, trustServerCert: false } }), 'certificate');
      expect(e.codes).toContain('E230001');
    });
    it('also fails when the flag is omitted', async () => {
      await expectKind(client.info(url, { credentials: TESTER }), 'certificate');
    });
    it('succeeds with trustServerCert on', async () => {
      const i = await client.info(url, { credentials: { ...TESTER, trustServerCert: true } });
      expect(i.url).toBe(url);
    });
    it('does not persist the accepted certificate or credentials (no auth cache)', async () => {
      await client.info(url, { credentials: { ...TESTER, trustServerCert: true } });
      await expectKind(client.info(url, { credentials: { ...TESTER, trustServerCert: false } }), 'certificate');
      const authDir = path.join(process.env.APPDATA!, 'Subversion', 'auth');
      const files = fs.existsSync(authDir) ? fs.readdirSync(authDir, { recursive: true }).map(String) : [];
      expect(files.filter((f) => /simple|ssl\.server/i.test(f) && fs.statSync(path.join(authDir, f)).isFile())).toEqual([]);
    });
  });

  describe('incoming changes via status --show-updates', () => {
    it.each([
      ['alpha', 'svn', 'Modify'],
      ['beta', 'http', 'Modify'],
      ['beta', 'https', 'Folder'],
    ] as Array<[RepoName, Proto, string]>)('%s over %s detects %s after envctl incoming', async (repo, proto, action) => {
      const creds: Credentials = { ...TESTER, trustServerCert: proto === 'https' };
      const folder = wc(repo, proto);
      await client.run(['update'], { cwd: folder, credentials: creds });
      const before = await client.status(folder, { showUpdates: true, credentials: creds });
      expect(before.entries.filter((e) => e.repoItem && e.repoItem !== 'none' || e.repoProps && e.repoProps !== 'none')).toEqual([]);

      envctl('incoming', '--repo', repo, '--proto', proto, '--action', action);

      const after = await client.status(folder, { showUpdates: true, credentials: creds });
      const incoming = after.entries.filter((e) => (e.repoItem && e.repoItem !== 'none') || (e.repoProps && e.repoProps !== 'none'));
      expect(incoming.length).toBeGreaterThan(0);
      expect(after.youngest).toBeGreaterThan(before.youngest ?? 0);
      // Without -u the server side is not queried.
      const local = await client.status(folder, { credentials: creds });
      expect(local.entries.filter((e) => e.repoItem !== undefined || e.repoProps !== undefined)).toEqual([]);
      await client.run(['update'], { cwd: folder, credentials: creds });
      const synced = await client.status(folder, { showUpdates: true, credentials: creds });
      expect(synced.entries.filter((e) => e.repoItem && e.repoItem !== 'none')).toEqual([]);
    });
  });

  describe('authorization', () => {
    it.each(['svn', 'http'] as Proto[])('reader can read but a commit is refused over %s://', async (proto) => {
      const folder = wc('alpha', proto);
      const readerCreds: Credentials = READER;
      const i = await client.info(folder, { credentials: readerCreds });
      expect(i.revision).toBeGreaterThan(0);

      const added = path.join(folder, `reader-add-${Date.now()}.txt`);
      fs.writeFileSync(added, 'should never be committed');
      try {
        await client.run(['add', '--', added], { credentials: readerCreds });
        const e = await expectKind(client.run(['commit', '-m', 'reader must not commit', '--', added], { credentials: readerCreds }), 'auth');
        expect(e.message).not.toContain('reader-pass');
      } finally {
        await client.run(['revert', '--', added], { credentials: readerCreds, allowFailure: true });
        fs.rmSync(added, { force: true });
      }
    });
  });

  describe('failure modes', () => {
    it('unreachable server maps to offline', async () => {
      await expectKind(client.info('svn://127.0.0.1:1/nothing', { credentials: TESTER, timeoutMs: 20_000 }), 'offline');
    });
    it('a plain folder is notWorkingCopy', async () => {
      const dir = fs.mkdtempSync(path.join(SCRATCH, 'notwc-'));
      try {
        await expectKind(client.info(dir), 'notWorkingCopy');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
    it('missing svn path gives svnNotFound with guidance', async () => {
      const locator = new SvnLocator(() => 'Z:\\no\\such\\svn.exe', (o) => findSvnExe({ ...o, env: {}, exists: () => false }));
      const e = await expectKind(new SvnClient(locator, undefined).info(wc('alpha', 'svn')), 'svnNotFound');
      expect(e.message).toContain('Z:\\no\\such\\svn.exe');
    });
    it('a nonexistent executable path from the runner is svnNotFound', async () => {
      const locator = new SvnLocator(() => '', () => ({ path: 'Z:\\gone\\svn.exe', tried: [] }));
      await expectKind(new SvnClient(locator, undefined).version(), 'svnNotFound');
    });
    it('cancellation kills a running command', async () => {
      const ac = new AbortController();
      const p = client.info(`${PROTOS.svn.url('alpha')}/trunk`, { credentials: TESTER, signal: ac.signal });
      ac.abort();
      await expectKind(p, 'cancelled');
    });
    it('a tiny timeout produces kind timeout', async () => {
      await expectKind(client.run(['info', '--', `${PROTOS.https.url('alpha')}/trunk`], { credentials: { ...TESTER, trustServerCert: true }, timeoutMs: 1 }), 'timeout');
    });
  });

  it('never logs a password', () => {
    const all = logLines.join('\n');
    expect(all).not.toContain('tester-pass');
    expect(all).not.toContain('reader-pass');
    expect(all).not.toContain('definitely-wrong');
    expect(all).toContain('--password-from-stdin');
    expect(all).not.toMatch(/--password(?!-from-stdin)/);
  });
});

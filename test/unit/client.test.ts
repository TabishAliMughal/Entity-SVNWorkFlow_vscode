import { beforeEach, describe, expect, it, vi } from 'vitest';

const runProcess = vi.fn();
vi.mock('../../src/svn/runner', () => ({ runProcess: (...a: unknown[]) => runProcess(...a) }));

import { SvnClient, pegSafe, CredentialProvider, supportsPasswordFromStdin } from '../../src/svn/client';
import { SvnLocator } from '../../src/svn/locator';
import { SvnError } from '../../src/svn/errors';

const locator = new SvnLocator(() => '', () => ({ path: 'C:\\svn.exe', tried: [] }));
const okResult = (text = '') => ({ stdout: Buffer.from(text), stderr: '', exitCode: 0, text });

function lastCall(): { exe: string; args: string[]; opts: Record<string, unknown> } {
  const c = runProcess.mock.calls.at(-1)!;
  return { exe: c[0], args: c[1], opts: c[2] };
}

beforeEach(() => {
  runProcess.mockReset();
  runProcess.mockResolvedValue(okResult());
});

describe('SvnClient.run argument building', () => {
  it('adds --non-interactive after the subcommand and nothing else without credentials', async () => {
    await new SvnClient(locator, undefined).run(['update', '--', 'x']);
    expect(lastCall().exe).toBe('C:\\svn.exe');
    expect(lastCall().args).toEqual(['update', '--non-interactive', '--', 'x']);
  });
  it('adds --xml only when requested', async () => {
    const c = new SvnClient(locator, undefined);
    await c.run(['info'], { xml: true });
    expect(lastCall().args).toEqual(['info', '--non-interactive', '--xml']);
  });
  it('injects username, password and --no-auth-cache; password is registered as a secret', async () => {
    await new SvnClient(locator, undefined).run(['info', '--', 'u'], { credentials: { username: 'tester', password: 'pw' } });
    expect(lastCall().args).toEqual(['info', '--non-interactive', '--username', 'tester', '--password-from-stdin', '--no-auth-cache', '--', 'u']);
    expect(lastCall().opts.secrets).toEqual(['pw']);
    expect(lastCall().opts.stdin).toBe('pw');
  });
  it('never puts --password or the password value in args when stdin is supported', async () => {
    runProcess.mockImplementation(async (_e: string, a: string[]) => okResult(a[0] === '--version' ? '1.14.2\n' : ''));
    await new SvnClient(locator, undefined).run(['update', '--', 'x'], { credentials: { username: 'u', password: 'S3cret!' } });
    const { args } = lastCall();
    expect(args).not.toContain('--password');
    expect(args.join(' ')).not.toContain('S3cret!');
    expect(args).toContain('--password-from-stdin');
  });
  it('falls back to --password only for svn older than 1.10', async () => {
    runProcess.mockImplementation(async (_e: string, a: string[]) => okResult(a[0] === '--version' ? '1.9.7\n' : ''));
    await new SvnClient(locator, undefined).run(['update'], { credentials: { username: 'u', password: 'pw' } });
    expect(lastCall().args).toContain('--password');
    expect(lastCall().args).not.toContain('--password-from-stdin');
    expect(lastCall().opts.stdin).toBeUndefined();
  });
  it('caches the version lookup', async () => {
    runProcess.mockImplementation(async (_e: string, a: string[]) => okResult(a[0] === '--version' ? '1.14.2\n' : ''));
    const c = new SvnClient(locator, undefined);
    await c.run(['info'], { credentials: { password: 'a' } });
    await c.run(['info'], { credentials: { password: 'a' } });
    expect(runProcess.mock.calls.filter((x) => x[1][0] === '--version')).toHaveLength(1);
  });
  it('supportsPasswordFromStdin parses versions', () => {
    expect(supportsPasswordFromStdin('1.9.7')).toBe(false);
    expect(supportsPasswordFromStdin('1.10.0')).toBe(true);
    expect(supportsPasswordFromStdin('1.14.2')).toBe(true);
    expect(supportsPasswordFromStdin('2.0.0')).toBe(true);
    expect(supportsPasswordFromStdin('weird')).toBe(true);
  });
  it('username only still adds --no-auth-cache and no secrets', async () => {
    await new SvnClient(locator, undefined).run(['info'], { credentials: { username: 'u' } });
    expect(lastCall().args).toEqual(['info', '--non-interactive', '--username', 'u', '--no-auth-cache']);
    expect(lastCall().opts.secrets).toEqual([]);
  });
  it('passes the trust-cert flag only when trustServerCert is true', async () => {
    const c = new SvnClient(locator, undefined);
    await c.run(['info'], { credentials: { username: 'u', password: 'p', trustServerCert: true } });
    expect(lastCall().args).toContain('--trust-server-cert-failures=unknown-ca,cn-mismatch');
    await c.run(['info'], { credentials: { username: 'u', password: 'p', trustServerCert: false } });
    expect(lastCall().args.join(' ')).not.toContain('trust-server-cert');
    await c.run(['info'], { credentials: { username: 'u', password: 'p' } });
    expect(lastCall().args.join(' ')).not.toContain('trust-server-cert');
  });
  it('no credentials at all means no --no-auth-cache', async () => {
    await new SvnClient(locator, undefined).run(['info'], { credentials: {} });
    expect(lastCall().args).toEqual(['info', '--non-interactive']);
  });
  it('looks up stored credentials by repoName; explicit credentials win', async () => {
    const get = vi.fn(async (n: string) => ({ username: `user-${n}`, password: 'stored' }));
    const provider: CredentialProvider = { get };
    const c = new SvnClient(locator, provider);
    await c.run(['info'], { repoName: 'alpha' });
    expect(get).toHaveBeenCalledWith('alpha');
    expect(lastCall().args).toContain('user-alpha');
    await c.run(['info'], { repoName: 'alpha', credentials: { username: 'explicit' } });
    expect(lastCall().args).toContain('explicit');
    expect(lastCall().args).not.toContain('stored');
  });
  it('forwards cwd, signal, allowFailure and timeout (setting default and override)', async () => {
    const ac = new AbortController();
    const c = new SvnClient(locator, undefined, undefined, () => 4242);
    await c.run(['status'], { cwd: 'C:\\wc', signal: ac.signal, allowFailure: true });
    expect(lastCall().opts).toMatchObject({ cwd: 'C:\\wc', signal: ac.signal, allowFailure: true, timeoutMs: 4242 });
    await c.run(['status'], { timeoutMs: 7 });
    expect(lastCall().opts.timeoutMs).toBe(7);
  });
  it('throws svnNotFound before spawning when svn.exe is missing', async () => {
    const missing = new SvnLocator(() => '', () => ({ tried: [] }));
    await expect(new SvnClient(missing, undefined).run(['info'])).rejects.toMatchObject({ kind: 'svnNotFound' });
    expect(runProcess).not.toHaveBeenCalled();
  });
  it('propagates runner errors unchanged', async () => {
    runProcess.mockRejectedValue(new SvnError('auth', 'nope'));
    await expect(new SvnClient(locator, undefined).run(['info'])).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('SvnClient helpers', () => {
  it('info() runs svn info --xml and parses', async () => {
    runProcess.mockResolvedValue(
      okResult('<info><entry path="." revision="3" kind="dir"><url>svn://h/r</url></entry></info>'),
    );
    const i = await new SvnClient(locator, undefined).info('C:\\wc');
    expect(lastCall().args).toEqual(['info', '--non-interactive', '--xml', '--', 'C:\\wc']);
    expect(i.revision).toBe(3);
  });
  it('status() adds --show-updates only when asked', async () => {
    runProcess.mockResolvedValue(okResult('<status><target path="."/></status>'));
    const c = new SvnClient(locator, undefined);
    await c.status('C:\\wc');
    expect(lastCall().args).toEqual(['status', '--non-interactive', '--xml', '--', 'C:\\wc']);
    await c.status('C:\\wc', { showUpdates: true });
    expect(lastCall().args).toEqual(['status', '--non-interactive', '--xml', '--show-updates', '--', 'C:\\wc']);
  });
  it('version() trims', async () => {
    runProcess.mockResolvedValue(okResult('1.14.2\r\n'));
    expect(await new SvnClient(locator, undefined).version()).toBe('1.14.2');
  });
  it('pegSafe appends @ to local paths containing @ but not URLs', () => {
    expect(pegSafe('C:\\a@b\\f.txt')).toBe('C:\\a@b\\f.txt@');
    expect(pegSafe('C:\\a\\f.txt')).toBe('C:\\a\\f.txt');
    expect(pegSafe('svn://h/a@b')).toBe('svn://h/a@b');
  });
});

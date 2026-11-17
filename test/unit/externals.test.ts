import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalsGuard, type ExternalsChoice, type ExternalsPrompt } from '../../src/externals/guard';
import { externalsFromXml, foreignExternals, originOf, parseExternalsValue, resolveExternalOrigin } from '../../src/externals/model';
import type { RepoEntry } from '../../src/repos/model';
import { SvnClient, type ExternalsPolicy } from '../../src/svn/client';
import { SvnLocator } from '../../src/svn/locator';

const runProcess = vi.fn();
vi.mock('../../src/svn/runner', () => ({ runProcess: (...a: unknown[]) => runProcess(...a) }));

const propXml = (target: string, value: string): string =>
  `<?xml version="1.0"?><properties><target path="${target}"><property name="svn:externals">${value.replace(/&/g, '&amp;')}</property></target></properties>`;

describe('externals model', () => {
  it('computes origins with default ports and ignores credentials in the URL', () => {
    expect(originOf('https://Example.org/svn/x')).toBe('https://example.org:443');
    expect(originOf('http://u:p@h.example:80/x')).toBe('http://h.example:80');
    expect(originOf('svn://h/r')).toBe('svn://h:3690');
    expect(originOf('^/x')).toBeUndefined();
  });

  it('resolves relative externals to the repo origin; //host takes the scheme but names its own host', () => {
    const repo = 'https://svn.corp:443';
    expect(resolveExternalOrigin('^/lib', repo)).toBe(repo);
    expect(resolveExternalOrigin('../lib', repo)).toBe(repo);
    expect(resolveExternalOrigin('/svn/lib', repo)).toBe(repo);
    expect(resolveExternalOrigin('//evil.example/svn/lib', repo)).toBe('https://evil.example:443');
    expect(resolveExternalOrigin('//svn.corp/other', repo)).toBe(repo);
    expect(resolveExternalOrigin('svn://other/x', repo)).toBe('svn://other:3690');
  });

  it('parses the new and the old definition formats, revisions, quotes and comments', () => {
    const v = [
      '# comment',
      '^/lib libdir',
      '-r 12 http://a.example/r/x x-dir',
      '-r12 http://a.example/r/y y-dir',
      'old-dir -r 5 http://b.example/r',
      '"svn://c.example/with space" "dir name"',
      'http://d.example/r/f@7 peg',
      'bad',
    ].join('\n');
    expect(parseExternalsValue(v)).toEqual([
      { url: '^/lib', localDir: 'libdir' },
      { url: 'http://a.example/r/x', localDir: 'x-dir' },
      { url: 'http://a.example/r/y', localDir: 'y-dir' },
      { url: 'http://b.example/r', localDir: 'old-dir' },
      { url: 'svn://c.example/with space', localDir: 'dir name' },
      { url: 'http://d.example/r/f@7', localDir: 'peg' },
    ]);
  });

  it('flags only externals on another origin that are not trusted', () => {
    const repoOrigin = 'http://h:80';
    const xml = propXml('C:/wc', ['^/a a', '//other.example/x b', 'http://h/svn/r c', 'svn://h/r d', 'file:///repo e'].join('\n'));
    const refs = externalsFromXml(xml, repoOrigin, (p) => path.resolve(p));
    expect(foreignExternals(refs, repoOrigin).map((r) => r.localDir)).toEqual(['b', 'd']);
    expect(foreignExternals(refs, repoOrigin, ['svn://h:3690']).map((r) => r.localDir)).toEqual(['b']);
    expect(foreignExternals(refs, repoOrigin, ['http://other.example']).map((r) => r.localDir)).toEqual(['d']);
    expect(foreignExternals(refs, repoOrigin, ['https://other.example']).map((r) => r.localDir)).toEqual(['b', 'd']);
  });
});

const repo: RepoEntry = { name: 'alpha', serverUrl: 'http://h:80/svn/alpha/trunk', localFolder: path.resolve('C:/wc') };

function makeGuard(over: { value?: string; choice?: ExternalsChoice; repo?: RepoEntry; statusXml?: string; headValue?: string } = {}) {
  const prompts: ExternalsPrompt[] = [];
  const trusted: string[][] = [];
  let r = over.repo ?? repo;
  const client = {
    run: vi.fn(async (args: string[]) => {
      if (args[0] === 'propget' && args.includes('-r')) return { text: propXml(path.resolve('C:/wc/sub'), over.headValue ?? ''), stdout: Buffer.alloc(0), stderr: '', exitCode: 0 };
      if (args[0] === 'propget') return { text: over.value === undefined ? '<properties/>' : propXml(path.resolve('C:/wc'), over.value), stdout: Buffer.alloc(0), stderr: '', exitCode: 0 };
      if (args[0] === 'status') return { text: over.statusXml ?? '<status><target path="x"/></status>', stdout: Buffer.alloc(0), stderr: '', exitCode: 0 };
      throw new Error(`unexpected ${args[0]}`);
    }),
  };
  const guard = new ExternalsGuard({
    client: client as never,
    findRepo: () => r,
    prompt: async (p) => {
      prompts.push(p);
      return over.choice ?? 'cancel';
    },
    trust: async (_n, origins) => {
      trusted.push([...origins]);
      r = { ...r, trustedExternalHosts: [...(r.trustedExternalHosts ?? []), ...origins] };
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  return { guard, prompts, trusted, client };
}
const req = (args: string[]) => ({ args, repoName: 'alpha', cwd: repo.localFolder, credentials: { username: 'u', password: 'p' } });
const UPDATE = ['update', '--', path.resolve('C:/wc')];

describe('ExternalsGuard', () => {
  it('lets same-origin and relative externals through silently', async () => {
    const { guard, prompts } = makeGuard({ value: '^/lib a\n../x b\nhttp://h/svn/other c' });
    expect(await guard.decide(req(UPDATE))).toEqual({ mode: 'proceed' });
    expect(prompts).toHaveLength(0);
  });

  it('prompts for a different host and lists it', async () => {
    const { guard, prompts } = makeGuard({ value: 'http://evil.example/x ext', choice: 'continue' });
    expect(await guard.decide(req(UPDATE))).toEqual({ mode: 'proceed' });
    expect(prompts[0].origins).toEqual(['http://evil.example:80']);
    expect(prompts[0].lines[0]).toContain('http://evil.example/x');
    expect(prompts[0].canSeparate).toBe(true);
  });

  it('treats //host as a possible other server', async () => {
    const { guard, prompts } = makeGuard({ value: '//evil.example/x ext', choice: 'ignore' });
    expect(await guard.decide(req(UPDATE))).toEqual({ mode: 'ignore' });
    expect(prompts).toHaveLength(1);
  });

  it('cancel throws a cancelled error; separate lists the external dirs and withholds credentials from foreign ones', async () => {
    const value = 'http://evil.example/x foreign\n^/lib local';
    await expect(makeGuard({ value, choice: 'cancel' }).guard.decide(req(UPDATE))).rejects.toMatchObject({ kind: 'cancelled' });
    const d = await makeGuard({ value, choice: 'separate' }).guard.decide(req(UPDATE));
    expect(d).toEqual({
      mode: 'separate',
      followUp: [
        { path: path.resolve('C:/wc/foreign'), withCredentials: false },
        { path: path.resolve('C:/wc/local'), withCredentials: true },
      ],
    });
  });

  it('"always trust" stores the origin and later runs are silent', async () => {
    const { guard, prompts, trusted } = makeGuard({ value: 'http://evil.example/x ext', choice: 'trust' });
    await guard.decide(req(UPDATE));
    expect(trusted).toEqual([['http://evil.example:80']]);
    guard.invalidate('alpha');
    expect(await guard.decide(req(UPDATE))).toEqual({ mode: 'proceed' });
    expect(prompts).toHaveLength(1);
  });

  it('caches the propget per working copy until invalidated', async () => {
    const { guard, client } = makeGuard({ value: '^/lib a' });
    await guard.decide(req(UPDATE));
    await guard.decide(req(UPDATE));
    const props = () => client.run.mock.calls.filter((c) => c[0][0] === 'propget' && !c[0].includes('-r')).length;
    expect(props()).toBe(1);
    guard.finished(req(UPDATE));
    await guard.decide(req(UPDATE));
    expect(props()).toBe(2);
  });

  it('status -u never prompts: foreign externals are skipped with --ignore-externals', async () => {
    const { guard, prompts } = makeGuard({ value: 'http://evil.example/x ext', choice: 'continue' });
    const d = await guard.decide(req(['status', '--show-updates', '--', path.resolve('C:/wc')]));
    expect(d).toEqual({ mode: 'ignore' });
    expect(prompts).toHaveLength(0);
  });

  it('ignores externals below folders that are not part of the update target', async () => {
    const { guard, prompts } = makeGuard({ value: 'http://evil.example/x ext' });
    expect(await guard.decide(req(['update', '--', path.resolve('C:/wc/elsewhere')]))).toEqual({ mode: 'proceed' });
    expect(prompts).toHaveLength(0);
  });

  it('looks at externals that the update itself would bring (changed folder props at HEAD)', async () => {
    const st = `<status><target path="C:/wc"><entry path="${path.resolve('C:/wc/sub')}"><wc-status item="normal" props="none"/><repos-status item="none" props="modified"/></entry></target></status>`;
    const { guard, prompts } = makeGuard({ value: '^/lib a', statusXml: st, headValue: 'http://evil.example/x brandnew', choice: 'ignore' });
    expect(await guard.decide(req(UPDATE))).toEqual({ mode: 'ignore' });
    expect(prompts[0].lines[0]).toContain('brandnew');
  });

  it('checkout asks about externals found on the repository URL', async () => {
    const { guard, prompts } = makeGuard({ value: 'http://evil.example/x ext', choice: 'ignore' });
    const d = await guard.decide({ args: ['checkout', '--', 'http://h/svn/alpha/trunk', 'C:/dest'], credentials: { username: 'u', password: 'p' } });
    expect(d).toEqual({ mode: 'ignore' });
    expect(prompts[0].canSeparate).toBe(false);
  });
});

describe('SvnClient externals policy', () => {
  const locator = new SvnLocator(() => '', () => ({ path: 'C:\\svn.exe', tried: [] }));
  beforeEach(() => {
    runProcess.mockReset();
    runProcess.mockResolvedValue({ stdout: Buffer.alloc(0), stderr: '', exitCode: 0, text: 'Updated to revision 3.\n' });
  });
  const calls = () => runProcess.mock.calls.map((c) => ({ args: c[1] as string[], stdin: (c[2] as { stdin?: string }).stdin }));

  it('adds --ignore-externals and never calls the policy without credentials or for other commands', async () => {
    const decide = vi.fn(async () => ({ mode: 'ignore' as const }));
    const c = new SvnClient(locator, undefined);
    c.setExternalsPolicy({ decide });
    await c.run(['update', '--', 'x'], { credentials: { username: 'u', password: 'p' } });
    expect(calls().find((x) => x.args[0] === 'update')?.args).toContain('--ignore-externals');
    await c.run(['update', '--', 'x']);
    await c.run(['commit', '--', 'x'], { credentials: { username: 'u', password: 'p' } });
    await c.run(['status', '--', 'x'], { credentials: { username: 'u', password: 'p' } });
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('does not ask again when --ignore-externals is already given', async () => {
    const decide = vi.fn(async () => ({ mode: 'proceed' as const }));
    const c = new SvnClient(locator, undefined);
    c.setExternalsPolicy({ decide });
    await c.run(['update', '--ignore-externals', '--', 'x'], { credentials: { username: 'u', password: 'p' } });
    expect(decide).not.toHaveBeenCalled();
  });

  it('separate mode updates each external; foreign ones get no credentials (and no password on the command line)', async () => {
    const policy: ExternalsPolicy = {
      decide: async () => ({ mode: 'separate', followUp: [{ path: 'C:\\wc\\f', withCredentials: false }, { path: 'C:\\wc\\l', withCredentials: true }] }),
    };
    const c = new SvnClient(locator, undefined);
    c.setExternalsPolicy(policy);
    await c.run(['update', '--', 'C:\\wc'], { credentials: { username: 'u', password: 'secret' } });
    const all = calls().filter((x) => x.args[0] === 'update');
    expect(all).toHaveLength(3);
    expect(all[0].args).toContain('--ignore-externals');
    expect(all[0].stdin).toBe('secret');
    expect(all[1].args.join(' ')).not.toMatch(/--username|--password|secret/);
    expect(all[1].stdin).toBeUndefined();
    expect(all[2].args).toContain('--password-from-stdin');
    for (const a of all) expect(a.args).not.toContain('--password');
  });

  it('a failing external update is reported in the result instead of failing the update', async () => {
    runProcess.mockImplementation(async (_e: string, args: string[]) => {
      if (args.includes('C:\\wc\\f')) throw new Error('E170001: auth failed');
      return { stdout: Buffer.alloc(0), stderr: '', exitCode: 0, text: 'Updated to revision 3.\n' };
    });
    const c = new SvnClient(locator, undefined);
    c.setExternalsPolicy({ decide: async () => ({ mode: 'separate', followUp: [{ path: 'C:\\wc\\f', withCredentials: false }] }) });
    const r = await c.run(['update', '--', 'C:\\wc'], { credentials: { username: 'u', password: 'p' } });
    expect(r.text).toContain('External C:\\wc\\f was not updated (no credentials offered)');
  });

  it('the execution gate stops svn from starting', async () => {
    const c = new SvnClient(locator, undefined);
    c.setExecutionGate(() => 'untrusted workspace');
    await expect(c.run(['info'])).rejects.toMatchObject({ kind: 'untrusted' });
    expect(runProcess).not.toHaveBeenCalled();
    c.setExecutionGate(undefined);
    await c.run(['info']);
    expect(runProcess).toHaveBeenCalled();
  });
});

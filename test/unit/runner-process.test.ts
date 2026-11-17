import { describe, expect, it } from 'vitest';
import { runProcess } from '../../src/svn/runner';
import { SvnError } from '../../src/svn/errors';
import { Logger } from '../../src/util/logger';

const node = process.execPath;
const js = (code: string, extra: string[] = []): string[] => ['-e', code, ...extra];

function memLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push = (m: string): void => {
    lines.push(m);
  };
  return { lines, info: push, warn: push, error: push, debug: push };
}

async function fail(p: Promise<unknown>): Promise<SvnError> {
  try {
    await p;
  } catch (e) {
    return e as SvnError;
  }
  throw new Error('expected rejection');
}

describe('runProcess', () => {
  it('captures stdout bytes, text and exit code', async () => {
    const r = await runProcess(node, js('process.stdout.write("h\\u00e9llo")'));
    expect(r.exitCode).toBe(0);
    expect(r.text).toBe('héllo');
    expect(r.stdout.equals(Buffer.from('héllo', 'utf8'))).toBe(true);
  });
  it('does not go through a shell (metacharacters are literal)', async () => {
    const r = await runProcess(node, js('process.stdout.write(process.argv[1])', ['a & b | "c" %PATH%']));
    expect(r.text).toBe('a & b | "c" %PATH%');
  });
  it('writes opts.stdin to the child as is (no newline added) and closes stdin', async () => {
    const r = await runProcess(node, js('let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.stringify(d)))'), { stdin: 'pw 1' });
    expect(r.text).toBe(JSON.stringify('pw 1'));
  });
  it('closes stdin when none is given (child reading stdin does not hang)', async () => {
    const r = await runProcess(node, js('process.stdin.on("data",()=>{}).on("end",()=>process.stdout.write("eof"))'));
    expect(r.text).toBe('eof');
  });
  it('rejects ENOENT as svnNotFound', async () => {
    const e = await fail(runProcess('Z:\\definitely\\missing\\svn.exe', ['info']));
    expect(e.kind).toBe('svnNotFound');
  });
  it('maps non-zero exit via stderr classification', async () => {
    const e = await fail(runProcess(node, js('console.error("svn: E170001: Authentication failed"); process.exit(1)')));
    expect(e.kind).toBe('auth');
    expect(e.exitCode).toBe(1);
    expect(e.codes).toContain('E170001');
    expect(e.message).toContain('Authentication failed');
  });
  it('allowFailure returns the result instead of throwing', async () => {
    const r = await runProcess(node, js('console.error("x"); process.exit(3)'), { allowFailure: true });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('x');
  });
  it('redacts secrets from stderr, error message and the command log', async () => {
    const log = memLogger();
    const e = await fail(
      runProcess(node, js('const s=process.argv[3]; console.error("svn: E999999: bad "+s+" for u:"+s+"@h"); process.exit(1)', ['--', '--password', 'hunter2']), {
        secrets: ['hunter2'],
        logger: log,
      }),
    );
    expect(e.message).not.toContain('hunter2');
    expect(e.stderr).not.toContain('hunter2');
    expect(log.lines.join('\n')).not.toContain('hunter2');
    expect(log.lines.join('\n')).toContain('--password ********');
  });
  it('times out with kind timeout', async () => {
    const e = await fail(runProcess(node, js('setTimeout(()=>{},30000)'), { timeoutMs: 300 }));
    expect(e.kind).toBe('timeout');
  });
  it('cancels via AbortSignal with kind cancelled', async () => {
    const ac = new AbortController();
    const p = runProcess(node, js('setTimeout(()=>{},30000)'), { signal: ac.signal, timeoutMs: 30000 });
    setTimeout(() => ac.abort(), 300);
    expect((await fail(p)).kind).toBe('cancelled');
  });
  it('rejects immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    expect((await fail(runProcess(node, js('1'), { signal: ac.signal }))).kind).toBe('cancelled');
  });
});

import { describe, expect, it } from 'vitest';
import { CommandHistory, commandLine, formatRecord, parseVerbosity } from '../../src/cmdlog/model';
import { runProcess, type CommandRecord } from '../../src/svn/runner';

const rec = (over: Partial<CommandRecord & { repoName?: string }> = {}) => ({
  time: Date.UTC(2025, 0, 2, 3, 4, 5),
  args: ['update', '--non-interactive', '--username', 'tester', '--password', '********', '--', 'a b'],
  cwd: 'C:\\wc',
  exitCode: 0,
  durationMs: 12,
  stderr: '',
  stdout: 'U  a.txt\n',
  repoName: 'alpha',
  ...over,
});

describe('command log', () => {
  it('formats the exact command with repo, cwd, exit and duration', () => {
    const s = formatRecord(rec(), 'commands');
    expect(s).toContain('2025-01-02T03:04:05.000Z');
    expect(s).toContain('repo=alpha cwd=C:\\wc');
    expect(s).toContain('> svn update --non-interactive --username tester --password ******** -- "a b"');
    expect(s).toContain('exit 0 in 12 ms');
    expect(s).not.toContain('U  a.txt');
  });
  it('adds output at the highest verbosity', () => {
    const s = formatRecord(rec({ stderr: 'oops' }), 'commandsAndOutput');
    expect(s).toContain('stdout:');
    expect(s).toContain('U  a.txt');
    expect(s).toContain('stderr:');
  });
  it('copy command never contains a password, even when the record was not pre-masked', () => {
    const line = commandLine({ args: ['info', '--password', 'hunter2', '--password=hunter3', 'svn://u:hunter4@h/r'] });
    expect(line).not.toMatch(/hunter/);
    expect(formatRecord(rec({ args: ['info', '--password', 'hunter2'] }), 'commands')).not.toContain('hunter2');
  });
  it('parses verbosity and bounds the history', () => {
    expect(parseVerbosity('off')).toBe('off');
    expect(parseVerbosity('bogus')).toBe('commands');
    const h = new CommandHistory(2);
    for (let i = 0; i < 3; i++) h.add(rec({ exitCode: i }));
    expect(h.list().map((r) => r.exitCode)).toEqual([2, 1]);
  });
  it('runProcess reports redacted records with exit code and duration', async () => {
    const got: CommandRecord[] = [];
    await runProcess(process.execPath, ['-e', 'const p = process.argv[process.argv.length - 1]; console.error("pw " + p + " bad"); console.log("out " + p)', '--', '--password', 'hunter2'], {
      secrets: ['hunter2'],
      allowFailure: true,
      cwd: process.cwd(),
      onFinish: (r) => got.push(r),
    });
    expect(got).toHaveLength(1);
    expect(JSON.stringify(got[0])).not.toContain('hunter2');
    expect(got[0].args.slice(-2)).toEqual(['--password', '********']);
    expect(got[0].exitCode).toBe(0);
    expect(got[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(got[0].stdout).toContain('out ********');
    expect(got[0].stderr).toContain('pw ********');
  });
  it('reports spawn failures redacted', async () => {
    const got: CommandRecord[] = [];
    await expect(runProcess('Z:\\no\\such\\svn.exe', ['--password', 'hunter2'], { secrets: ['hunter2'], onFinish: (r) => got.push(r) })).rejects.toThrow();
    expect(got[0].exitCode).toBe(-1);
    expect(JSON.stringify(got[0])).not.toContain('hunter2');
  });
});

import { spawn } from 'node:child_process';
import { SvnError, classifyStderr, firstErrorLine } from './errors';
import { Logger, nullLogger } from '../util/logger';
import { quoteForLog, redactArgs, redactText } from '../util/redact';

/** One finished svn invocation, already redacted. Delivered to RunOptions.onFinish for the command log. */
export interface CommandRecord {
  time: number;
  args: string[];
  cwd?: string;
  exitCode: number;
  durationMs: number;
  stderr: string;
  /** Redacted UTF-8 start of stdout (capped). */
  stdout: string;
  error?: string;
}

export const MAX_RECORD_OUTPUT = 4000;

export interface RunOptions {
  onFinish?: (rec: CommandRecord) => void;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  logger?: Logger;
  /** Secret values to scrub from stderr/log output. */
  secrets?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** Do not throw on a non-zero exit (e.g. svn diff). */
  allowFailure?: boolean;
  /**
   * Written to the child's stdin as is, then stdin is closed. Used for --password-from-stdin: no trailing newline,
   * because svn on Windows ends the line at CRLF only (a bare LF would become part of the password) and EOF ends it too.
   */
  stdin?: string;
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
  /** stdout decoded as UTF-8. */
  text: string;
}

/** Spawns exe with an argument array (never through a shell). */
export function runProcess(exe: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  const log = opts.logger ?? nullLogger;
  const secrets = opts.secrets ?? [];
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new SvnError('cancelled', 'Operation cancelled'));
      return;
    }
    log.info(`> svn ${quoteForLog(args)}${opts.cwd ? `  (cwd: ${opts.cwd})` : ''}`);
    const started = Date.now();
    const emit = (exitCode: number, stderr: string, stdout: Buffer | undefined, error?: string): void => {
      if (!opts.onFinish) return;
      try {
        opts.onFinish({
          time: started,
          args: redactArgs(args),
          cwd: opts.cwd,
          exitCode,
          durationMs: Date.now() - started,
          stderr: redactText(stderr, secrets),
          stdout: stdout ? redactText(stdout.subarray(0, MAX_RECORD_OUTPUT).toString('utf8'), secrets) : '',
          error: error === undefined ? undefined : redactText(error, secrets),
        });
      } catch {
        // a faulty observer must never break svn
      }
    };
    const child = spawn(exe, [...args], {
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...opts.env, LC_ALL: 'C' },
    });
    child.stdin.on('error', () => {
      // svn may exit before reading stdin (EPIPE); the exit code carries the result
    });
    child.stdin.end(opts.stdin);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let cancelled = false;

    const onAbort = (): void => {
      cancelled = true;
      kill();
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const kill = (): void => {
      if (child.pid === undefined) return;
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false }).on('error', () => child.kill());
      } else {
        child.kill('SIGKILL');
      }
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs ?? 120_000);

    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      finish(() => {
        emit(-1, '', undefined, e.message);
        reject(new SvnError(e.code === 'ENOENT' ? 'svnNotFound' : 'unknown', redactText(e.message, secrets)));
      });
    });
    child.on('close', (code) => {
      finish(() => {
        const stderr = redactText(Buffer.concat(err).toString('utf8'), secrets);
        const exitCode = code ?? -1;
        log.info(`< exit ${exitCode} in ${Date.now() - started}ms`);
        if (stderr.trim()) log.debug(stderr.trim());
        emit(exitCode, stderr, Buffer.concat(out), cancelled ? 'cancelled' : timedOut ? 'timed out' : undefined);
        if (cancelled) return reject(new SvnError('cancelled', 'Operation cancelled', exitCode, stderr));
        if (timedOut) return reject(new SvnError('timeout', 'svn command timed out', exitCode, stderr));
        const stdout = Buffer.concat(out);
        if (exitCode !== 0 && !opts.allowFailure) {
          const { kind, codes } = classifyStderr(stderr);
          return reject(new SvnError(kind, redactText(firstErrorLine(stderr), secrets), exitCode, stderr, codes));
        }
        resolve({ stdout, stderr, exitCode, text: stdout.toString('utf8') });
      });
    });
  });
}

import { SvnLocator } from './locator';
import { CommandRecord, RunResult, runProcess } from './runner';
import { SvnError } from './errors';
import { SvnInfo, StatusEntry, parseInfo, parseStatus } from './xml';
import { Logger, nullLogger } from '../util/logger';

export interface Credentials {
  username?: string;
  password?: string;
  /** Pass --trust-server-cert-failures for self-signed/internal https certs. */
  trustServerCert?: boolean;
}

/** Looks up credentials by repo name. Implemented by repos/credentials.ts. */
export interface CredentialProvider {
  get(repoName: string): Promise<Credentials | undefined>;
}

export interface SvnRunOptions {
  /** Repo whose stored credentials are injected. */
  repoName?: string;
  /** Explicit credentials (e.g. while validating before they are saved); win over repoName. */
  credentials?: Credentials;
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  allowFailure?: boolean;
  /** Extra environment variables for the svn process (e.g. SVN_EXPERIMENTAL_COMMANDS). */
  env?: NodeJS.ProcessEnv;
  /** Append --xml. Default false. */
  xml?: boolean;
  /** Internal: this call is made by the externals guard or one of its follow-ups. */
  skipExternalsGuard?: boolean;
}

/** What to do with svn:externals before credentials are sent along with update/checkout/switch/export. */
export type ExternalsDecision =
  | { mode: 'proceed' }
  | { mode: 'ignore' }
  /** Main command with --ignore-externals, then each listed path is updated on its own. */
  | { mode: 'separate'; followUp: Array<{ path: string; withCredentials: boolean }> };

export interface ExternalsRequest {
  /** args as passed to run(): args[0] is the subcommand. */
  args: readonly string[];
  repoName?: string;
  cwd?: string;
  signal?: AbortSignal;
  credentials: Credentials;
}

export interface ExternalsPolicy {
  /** Throws SvnError('cancelled') when the user declines. */
  decide(req: ExternalsRequest): Promise<ExternalsDecision>;
  /** After the guarded command ended (successfully or not): cached externals of the repo are stale. */
  finished?(req: ExternalsRequest): void;
}

/** Decides whether `trustServerCert` may really be applied to this call (pinned fingerprint still matches). */
export type CertificatePolicy = (repoName: string | undefined, args: readonly string[]) => Promise<boolean>;

const GUARDED = new Set(['update', 'up', 'checkout', 'co', 'switch', 'sw', 'export']);

/** update/checkout/switch/export fetch externals; `status -u` also contacts the servers of working-copy externals. */
export function isExternalsCommand(args: readonly string[]): boolean {
  const sub = args[0];
  if (args.includes('--ignore-externals')) return false;
  if (GUARDED.has(sub)) return true;
  return (sub === 'status' || sub === 'st') && (args.includes('--show-updates') || args.includes('-u'));
}

/**
 * Typed wrapper around svn.exe. args[0] is the subcommand; global options
 * (--non-interactive, --xml, credentials) are inserted right after it, so
 * callers should put any `--` path separator inside args themselves.
 */
export class SvnClient {
  constructor(
    private readonly locator: SvnLocator,
    private readonly credentials: CredentialProvider | undefined,
    private readonly logger: Logger = nullLogger,
    private readonly getTimeoutMs: () => number = () => 120_000,
  ) {}

  private observer?: (rec: CommandRecord & { repoName?: string }) => void;
  private externals?: ExternalsPolicy;
  private certPolicy?: CertificatePolicy;
  private gate?: () => string | undefined;
  private configDir?: string;

  /** Receives every finished svn command (redacted); used by the command log. */
  setCommandObserver(fn: ((rec: CommandRecord & { repoName?: string }) => void) | undefined): void {
    this.observer = fn;
  }

  setExternalsPolicy(p: ExternalsPolicy | undefined): void {
    this.externals = p;
  }

  setCertificatePolicy(p: CertificatePolicy | undefined): void {
    this.certPolicy = p;
  }

  /** Use this svn configuration/auth directory instead of the user's (end-to-end tests only; svn.exe ignores %APPDATA% overrides). */
  setConfigDir(dir: string | undefined): void {
    this.configDir = dir;
  }

  /** While the gate returns a message, no svn process is started (untrusted workspace). */
  setExecutionGate(g: (() => string | undefined) | undefined): void {
    this.gate = g;
  }

  async run(args: readonly string[], opts: SvnRunOptions = {}): Promise<RunResult> {
    const blocked = this.gate?.();
    if (blocked) throw new SvnError('untrusted', blocked);
    const creds = opts.credentials ?? (opts.repoName ? await this.credentials?.get(opts.repoName) : undefined);
    const hasCreds = !!(creds?.username || creds?.password);
    if (!this.externals || !creds || !hasCreds || opts.skipExternalsGuard || !isExternalsCommand(args)) return this.exec(args, opts, creds);

    const req: ExternalsRequest = { args, repoName: opts.repoName, cwd: opts.cwd, signal: opts.signal, credentials: creds };
    try {
      const d = await this.externals.decide(req);
      if (d.mode === 'proceed') return await this.exec(args, opts, creds);
      const [sub, ...rest] = args;
      const res = await this.exec([sub, '--ignore-externals', ...rest], opts, creds);
      if (d.mode !== 'separate') return res;
      let extra = '';
      for (const f of d.followUp) {
        try {
          const r = await this.run(['update', '--', pegSafe(f.path)], {
            ...opts,
            credentials: f.withCredentials ? creds : {},
            skipExternalsGuard: true,
            xml: false,
          });
          extra += `\n${r.text}`;
        } catch (e) {
          if (e instanceof SvnError && e.kind === 'cancelled') throw e;
          const msg = `External ${f.path} was not updated${f.withCredentials ? '' : ' (no credentials offered)'}: ${e instanceof Error ? e.message : String(e)}`;
          this.logger.warn(msg);
          extra += `\n${msg}`;
        }
      }
      return extra ? { ...res, text: res.text + extra } : res;
    } finally {
      this.externals.finished?.(req);
    }
  }

  private async exec(args: readonly string[], opts: SvnRunOptions, creds: Credentials | undefined): Promise<RunResult> {
    const exe = this.locator.getExe();
    const globals = ['--non-interactive'];
    if (this.configDir) globals.push('--config-dir', this.configDir);
    if (opts.xml) globals.push('--xml');
    const secrets: string[] = [];
    let stdin: string | undefined;
    if (creds?.username) globals.push('--username', creds.username);
    if (creds?.password) {
      // The password must not appear on the command line (visible to other local users); svn 1.10+ reads it from stdin.
      if (await this.supportsPasswordStdin()) {
        globals.push('--password-from-stdin');
        stdin = creds.password;
      } else {
        globals.push('--password', creds.password);
      }
      secrets.push(creds.password);
    }
    if (creds?.trustServerCert && (!this.certPolicy || (await this.certPolicy(opts.repoName, args)))) {
      globals.push('--trust-server-cert-failures=unknown-ca,cn-mismatch');
    }
    // Don't let svn write the injected credentials to its own auth cache.
    if (creds?.username || creds?.password) globals.push('--no-auth-cache');
    const [sub, ...rest] = args;
    return runProcess(exe, [sub, ...globals, ...rest], {
      cwd: opts.cwd,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? this.getTimeoutMs(),
      logger: this.logger,
      secrets,
      stdin,
      allowFailure: opts.allowFailure,
      env: opts.env,
      onFinish: this.observer ? (rec) => this.observer?.({ ...rec, repoName: opts.repoName }) : undefined,
    });
  }

  private versionPromise?: Promise<string>;

  /** svn client version (e.g. "1.14.2"); cached after the first success. */
  version(): Promise<string> {
    if (!this.versionPromise) {
      const p = this.run(['--version', '--quiet']).then((r) => r.text.trim());
      this.versionPromise = p;
      p.catch(() => {
        if (this.versionPromise === p) this.versionPromise = undefined;
      });
    }
    return this.versionPromise;
  }

  /** --password-from-stdin exists since svn 1.10; an unparsable version is assumed modern. */
  private async supportsPasswordStdin(): Promise<boolean> {
    let v: string;
    try {
      v = await this.version();
    } catch {
      return true;
    }
    return supportsPasswordFromStdin(v);
  }

  /** svn info --xml on a local path or URL. */
  async info(target: string, opts: SvnRunOptions = {}): Promise<SvnInfo> {
    const r = await this.run(['info', '--', pegSafe(target)], { ...opts, xml: true });
    return parseInfo(r.text);
  }

  /** svn status --xml; showUpdates adds --show-updates (contacts the server). */
  async status(
    target: string,
    opts: SvnRunOptions & { showUpdates?: boolean; noIgnore?: boolean } = {},
  ): Promise<{ entries: StatusEntry[]; youngest?: number }> {
    const args = ['status'];
    if (opts.showUpdates) args.push('--show-updates');
    if (opts.noIgnore) args.push('--no-ignore');
    args.push('--', pegSafe(target));
    const r = await this.run(args, { ...opts, xml: true });
    return parseStatus(r.text);
  }
}

export function supportsPasswordFromStdin(version: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return true;
  const major = Number(m[1]);
  return major > 1 || Number(m[2]) >= 10;
}

/** A path containing '@' would be read as a peg revision; a trailing '@' disambiguates. */
export function pegSafe(target: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return target;
  return target.includes('@') ? `${target}@` : target;
}

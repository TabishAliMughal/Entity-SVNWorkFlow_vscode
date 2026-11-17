import * as path from 'node:path';
import { isSameOrUnder } from '../incoming/model';
import type { RepoEntry } from '../repos/model';
import type { ExternalsDecision, ExternalsPolicy, ExternalsRequest, SvnClient } from '../svn/client';
import { pegSafe } from '../svn/client';
import { SvnError } from '../svn/errors';
import { parseStatus } from '../svn/xml';
import type { Logger } from '../util/logger';
import { ExternalRef, externalsFromXml, foreignExternals, originOf } from './model';

export type ExternalsChoice = 'ignore' | 'separate' | 'continue' | 'trust' | 'cancel';

export interface ExternalsPrompt {
  repoName: string;
  repoUrl: string;
  /** One line per foreign external: `<dir>: <url>`. */
  lines: string[];
  origins: string[];
  /** The "update externals separately without credentials" and "always trust" choices apply. */
  canSeparate: boolean;
  canTrust: boolean;
}

export interface ExternalsGuardDeps {
  client: SvnClient;
  findRepo(name: string): RepoEntry | undefined;
  prompt(p: ExternalsPrompt): Promise<ExternalsChoice>;
  trust(repoName: string, origins: readonly string[]): Promise<void>;
  logger: Logger;
  now?: () => number;
  ttlMs?: number;
}

const UPDATE_SUBS = new Set(['update', 'up']);
const STATUS_SUBS = new Set(['status', 'st']);
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function afterDashes(args: readonly string[]): string[] {
  const i = args.indexOf('--');
  return i < 0 ? [] : args.slice(i + 1);
}

/**
 * Guards update/checkout/switch/export/status -u: command-line credentials are offered to every server the
 * command contacts, including the servers named by svn:externals. Externals on another origin need a decision.
 */
export class ExternalsGuard implements ExternalsPolicy {
  private readonly cache = new Map<string, { at: number; refs: ExternalRef[] }>();
  private readonly warned = new Set<string>();

  constructor(private readonly d: ExternalsGuardDeps) {}

  /** Forget the externals of a working copy (properties or content changed). */
  invalidate(repoName: string): void {
    this.cache.delete(repoName.toLowerCase());
  }

  finished(req: ExternalsRequest): void {
    // status -u cannot change properties or the working copy
    if (req.repoName && !STATUS_SUBS.has(req.args[0])) this.invalidate(req.repoName);
  }

  async decide(req: ExternalsRequest): Promise<ExternalsDecision> {
    const sub = req.args[0];
    const targets = afterDashes(req.args);
    const repo = req.repoName ? this.d.findRepo(req.repoName) : undefined;
    const urlTargets = targets.filter((t) => URL_RE.test(t));
    const repoUrl = repo?.serverUrl ?? urlTargets[0];
    const repoOrigin = repoUrl ? originOf(repoUrl) : undefined;
    if (!repoOrigin) return { mode: 'proceed' };

    const isUpdate = UPDATE_SUBS.has(sub);
    const localTargets = targets.filter((t) => !URL_RE.test(t)).map((t) => path.resolve(req.cwd ?? '', t.replace(/@$/, '')));
    // checkout/export: the last argument is the destination, not something that carries externals yet
    const sources = sub === 'checkout' || sub === 'co' ? [] : sub === 'export' ? localTargets.slice(0, targets[0] && !URL_RE.test(targets[0]) ? 1 : 0) : localTargets;

    const refs: ExternalRef[] = [];
    try {
      for (const u of urlTargets) refs.push(...(await this.remote(req, u, repoOrigin)));
      if (repo && sources.length) refs.push(...(await this.local(req, repo, repoOrigin, sources)));
      else if (sources.length) for (const s of sources) refs.push(...(await this.localPath(req, s, repoOrigin)));
      if (isUpdate && repo) refs.push(...(await this.incoming(req, repo, repoOrigin, sources)));
    } catch (e) {
      if (e instanceof SvnError && e.kind === 'cancelled') throw e;
      // Cannot tell (e.g. offline): the command itself will fail the same way.
      this.d.logger.warn(`Externals check failed: ${e instanceof Error ? e.message : String(e)}`);
      return { mode: 'proceed' };
    }

    const inScope = refs.filter((r) => URL_RE.test(r.parent) || sources.length === 0 || sources.some((s) => isSameOrUnder(r.parent, s)));
    const trusted = repo?.trustedExternalHosts ?? [];
    const foreign = foreignExternals(inScope, repoOrigin, trusted);
    if (!foreign.length) return { mode: 'proceed' };

    const lines = [...new Set(foreign.map((f) => `${URL_RE.test(f.parent) ? f.localDir : path.join(f.parent, f.localDir)}: ${f.url}`))];
    const origins = [...new Set(foreign.map((f) => f.origin).filter((o): o is string => !!o))];

    if (STATUS_SUBS.has(sub)) {
      // Background incoming check: never prompt, never send credentials to an untrusted server.
      const key = `${req.repoName}|${origins.join(',')}`;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        this.d.logger.warn(`"${req.repoName}": externals on other servers are skipped by the incoming check (credentials are not sent): ${lines.join('; ')}`);
      }
      return { mode: 'ignore' };
    }

    const choice = await this.d.prompt({
      repoName: repo?.name ?? repoUrl ?? '',
      repoUrl: repoUrl ?? '',
      lines,
      origins,
      canSeparate: isUpdate,
      canTrust: !!repo && origins.length > 0,
    });
    this.d.logger.info(`Externals on other servers (${origins.join(', ') || 'unknown'}): choice ${choice}`);
    switch (choice) {
      case 'cancel':
        throw new SvnError('cancelled', 'Operation cancelled');
      case 'ignore':
        return { mode: 'ignore' };
      case 'continue':
        return { mode: 'proceed' };
      case 'trust':
        if (repo) await this.d.trust(repo.name, origins);
        return { mode: 'proceed' };
      case 'separate': {
        const trustedAll = new Set([...trusted, repoOrigin]);
        const seen = new Set<string>();
        const followUp: Array<{ path: string; withCredentials: boolean }> = [];
        for (const r of inScope) {
          if (URL_RE.test(r.parent)) continue;
          const p = path.resolve(r.parent, r.localDir);
          if (seen.has(p)) continue;
          seen.add(p);
          followUp.push({ path: p, withCredentials: !!r.origin && trustedAll.has(r.origin) });
        }
        return { mode: 'separate', followUp };
      }
    }
  }

  private run(req: ExternalsRequest, args: string[], extra: { cwd?: string } = {}) {
    return this.d.client.run(args, {
      repoName: req.repoName,
      credentials: req.repoName ? undefined : req.credentials,
      cwd: extra.cwd ?? req.cwd,
      signal: req.signal,
      xml: true,
      skipExternalsGuard: true,
    });
  }

  /** svn:externals on a repository URL (checkout / switch destination); only the repository itself is contacted. */
  private async remote(req: ExternalsRequest, url: string, repoOrigin: string): Promise<ExternalRef[]> {
    const r = await this.run(req, ['propget', '-R', 'svn:externals', '--', url.replace(/@$/, '')]);
    return externalsFromXml(r.text, repoOrigin, (p) => (URL_RE.test(p) ? p : url));
  }

  /** Whole working copy of a registered repo, cached. */
  private async local(req: ExternalsRequest, repo: RepoEntry, repoOrigin: string, _sources: readonly string[]): Promise<ExternalRef[]> {
    const key = repo.name.toLowerCase();
    const now = (this.d.now ?? Date.now)();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < (this.d.ttlMs ?? 60_000)) return hit.refs;
    const refs = await this.localPath(req, repo.localFolder, repoOrigin);
    this.cache.set(key, { at: now, refs });
    return refs;
  }

  private async localPath(req: ExternalsRequest, dir: string, repoOrigin: string): Promise<ExternalRef[]> {
    const r = await this.run(req, ['propget', '-R', 'svn:externals', '--', pegSafe(dir)], { cwd: dir });
    return externalsFromXml(r.text, repoOrigin, (p) => path.resolve(dir, p));
  }

  /**
   * Externals that the update itself would introduce: folders whose properties changed on the server are
   * looked at in HEAD. One extra `status -u --ignore-externals` round trip; only done when credentials are sent.
   */
  private async incoming(req: ExternalsRequest, repo: RepoEntry, repoOrigin: string, sources: readonly string[]): Promise<ExternalRef[]> {
    const dirs = sources.length ? sources : [repo.localFolder];
    const out: ExternalRef[] = [];
    const rIdx = req.args.findIndex((a) => a === '-r' || a === '--revision');
    const rev = rIdx >= 0 ? req.args[rIdx + 1] : 'HEAD';
    const st = await this.run(req, ['status', '--show-updates', '--ignore-externals', '--', ...dirs.map(pegSafe)]);
    const changed = parseStatus(st.text).entries.filter((e) => e.repoProps && e.repoProps !== 'none' && e.repoProps !== ' ');
    for (const e of changed.slice(0, 200)) {
      const p = path.resolve(req.cwd ?? repo.localFolder, e.path);
      try {
        const r = await this.run(req, ['propget', 'svn:externals', '-r', rev, '--', pegSafe(p)]);
        out.push(...externalsFromXml(r.text, repoOrigin, () => p));
      } catch (err) {
        if (err instanceof SvnError && err.kind === 'cancelled') throw err;
        // the item may not exist at that revision; nothing to check there
      }
    }
    return out;
  }
}

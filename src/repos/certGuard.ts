import { CertInfo, pinState, probeCertificate } from '../svn/certificate';
import type { CertificatePolicy } from '../svn/client';
import type { Logger } from '../util/logger';
import type { RepoEntry } from './model';

export interface CertGuardDeps {
  findRepo(name: string): RepoEntry | undefined;
  /** Stores the newly confirmed fingerprint on the repo entry. */
  repin(repoName: string, fingerprint: string): Promise<void>;
  /** Modal: the certificate differs from the confirmed one. true = trust the new certificate. */
  confirmChanged(repo: RepoEntry, info: CertInfo): Promise<boolean>;
  logger: Logger;
  probe?: (url: string) => Promise<CertInfo>;
  now?: () => number;
  /** How long a successful fingerprint check is reused (default 5 minutes). */
  ttlMs?: number;
}

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Makes `--trust-server-cert-failures` conditional: https only, and for a repo with a confirmed fingerprint only
 * while the server still presents that certificate. A changed certificate needs an explicit modal confirmation.
 */
export class CertGuard {
  private readonly verified = new Map<string, { at: number; fp: string }>();
  private readonly refused = new Set<string>();
  private readonly pending = new Map<string, Promise<boolean>>();

  constructor(private readonly d: CertGuardDeps) {}

  readonly policy: CertificatePolicy = (repoName, args) => this.allow(repoName, args);

  /** Call after the user confirmed a certificate (new pin) or removed trust. */
  reset(repoName: string): void {
    const k = repoName.toLowerCase();
    this.verified.delete(k);
    for (const r of [...this.refused]) if (r.startsWith(`${k}|`)) this.refused.delete(r);
  }

  async allow(repoName: string | undefined, args: readonly string[]): Promise<boolean> {
    const urls = args.filter((a) => URL_RE.test(a));
    if (!repoName) return urls.length === 0 || urls.some((u) => /^https:\/\//i.test(u));
    const repo = this.d.findRepo(repoName);
    if (!repo || !/^https:\/\//i.test(repo.serverUrl)) return false;
    if (!repo.trustedCertFingerprint) return true;

    const key = repo.name.toLowerCase();
    const now = (this.d.now ?? Date.now)();
    const hit = this.verified.get(key);
    if (hit && now - hit.at < (this.d.ttlMs ?? 300_000) && pinState(repo.trustedCertFingerprint, hit.fp) === 'match') return true;

    let info: CertInfo;
    try {
      info = await (this.d.probe ?? probeCertificate)(repo.serverUrl);
    } catch (e) {
      // Cannot verify the pin: fail closed, svn then reports the certificate error normally.
      this.d.logger.warn(`Certificate of "${repo.name}" could not be checked (${e instanceof Error ? e.message : String(e)}); not applying the trust flag.`);
      return false;
    }
    if (pinState(repo.trustedCertFingerprint, info.fingerprint) === 'match') {
      this.verified.set(key, { at: now, fp: info.fingerprint });
      return true;
    }
    const refKey = `${key}|${info.fingerprint}`;
    if (this.refused.has(refKey)) return false;
    let p = this.pending.get(refKey);
    if (!p) {
      this.d.logger.warn(`Certificate of "${repo.name}" CHANGED (pinned ${repo.trustedCertFingerprint}, server now ${info.fingerprint}).`);
      p = (async () => {
        const ok = await this.d.confirmChanged(repo, info);
        if (ok) {
          await this.d.repin(repo.name, info.fingerprint);
          this.verified.set(key, { at: (this.d.now ?? Date.now)(), fp: info.fingerprint });
        } else this.refused.add(refKey);
        return ok;
      })().finally(() => this.pending.delete(refKey));
      this.pending.set(refKey, p);
    }
    return p;
  }
}

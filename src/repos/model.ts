import { encodeSvnUrl } from '../util/svnUrl';

export interface RepoEntry {
  name: string;
  serverUrl: string;
  localFolder: string;
  /** Optional; the password is in SecretStorage. */
  username?: string;
  /** Accept self-signed / unknown-CA / CN-mismatch https certificates. Default off. */
  trustServerCert?: boolean;
  /** SHA-1 fingerprint (AA:BB:...) of the https certificate the user confirmed; a different one is refused until re-confirmed. */
  trustedCertFingerprint?: string;
  /** Origins (scheme://host:port) of svn:externals servers that may receive this repo's credentials. */
  trustedExternalHosts?: string[];
}

export const SUPPORTED_SCHEMES = ['svn:', 'http:', 'https:', 'svn+ssh:'] as const;

export interface UrlCheck {
  ok: boolean;
  /** Normalized URL (no trailing slash) when ok. */
  url?: string;
  error?: string;
}

export function checkServerUrl(input: string): UrlCheck {
  const raw = input.trim();
  if (!raw) return { ok: false, error: 'URL is required.' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'Not a valid URL. Example: svn://host/repo or https://host/svn/repo' };
  }
  if (!(SUPPORTED_SCHEMES as readonly string[]).includes(u.protocol)) {
    return { ok: false, error: 'Scheme must be svn://, http://, https:// or svn+ssh://' };
  }
  if (!u.hostname) return { ok: false, error: 'URL has no host.' };
  if (u.username || u.password) {
    return { ok: false, error: 'Do not embed credentials in the URL; use Set Repository Credentials.' };
  }
  return { ok: true, url: normalizeUrl(encodeSvnUrl(raw)) };
}

export function normalizeUrl(url: string): string {
  const t = url.trim().replace(/\/+$/, '');
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)(.*)$/i.exec(t);
  return m ? m[1].toLowerCase() + m[2].toLowerCase() + m[3] : t;
}

/** True if one URL is the same as, or a parent of, the other (either direction). */
export function urlsRelated(a: string, b: string): boolean {
  const x = normalizeUrl(a).toLowerCase();
  const y = normalizeUrl(b).toLowerCase();
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
}

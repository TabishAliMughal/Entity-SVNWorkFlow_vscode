import * as tls from 'node:tls';

export interface CertInfo {
  host: string;
  port: number;
  /** SHA-1 fingerprint, upper case, colon separated (the form svn prints). */
  fingerprint: string;
  issuer: string;
  subject: string;
  validFrom: string;
  validTo: string;
  /** false when the certificate does not cover the host name. */
  hostnameMatches: boolean;
}

/** Subset of tls.PeerCertificate that is used; lets tests inject certificates. */
export interface PeerCert {
  fingerprint?: string;
  issuer?: Record<string, string | string[] | undefined>;
  subject?: Record<string, string | string[] | undefined>;
  valid_from?: string;
  valid_to?: string;
  subjectaltname?: string;
}

export function normalizeFingerprint(fp: string): string {
  const hex = fp.replace(/[^0-9a-f]/gi, '').toUpperCase();
  return hex.match(/.{1,2}/g)?.join(':') ?? '';
}

export function sameFingerprint(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && normalizeFingerprint(a) === normalizeFingerprint(b);
}

function dn(o: Record<string, string | string[] | undefined> | undefined): string {
  if (!o) return '';
  return Object.entries(o)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : v}`)
    .join(', ');
}

/** `host` and `port` of an https/http(s) URL; undefined for other schemes. */
export function hostPortOf(url: string): { host: string; port: number } | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return undefined;
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port: u.port ? Number(u.port) : 443 };
  } catch {
    return undefined;
  }
}

export function describePeerCert(host: string, port: number, c: PeerCert): CertInfo {
  const hostnameErr = tls.checkServerIdentity(host, c as tls.PeerCertificate);
  return {
    host,
    port,
    fingerprint: normalizeFingerprint(c.fingerprint ?? ''),
    issuer: dn(c.issuer),
    subject: dn(c.subject),
    validFrom: c.valid_from ?? '',
    validTo: c.valid_to ?? '',
    hostnameMatches: !hostnameErr,
  };
}

/**
 * Reads the certificate the server presents (no trust decision is made here). The same fingerprint is what svn
 * shows in its own certificate prompt. Throws when the server cannot be reached or does not speak TLS.
 */
export function probeCertificate(url: string, timeoutMs = 8000): Promise<CertInfo> {
  const hp = hostPortOf(url);
  if (!hp) return Promise.reject(new Error('Only https:// URLs have a certificate.'));
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: hp.host, port: hp.port, servername: /^[\d.]+$|:/.test(hp.host) ? undefined : hp.host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      try {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.fingerprint) return reject(new Error('The server presented no certificate.'));
        resolve(describePeerCert(hp.host, hp.port, cert));
      } catch (e) {
        socket.destroy();
        reject(e);
      }
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`Timed out reading the certificate of ${hp.host}:${hp.port}`));
    });
    socket.on('error', (e) => reject(e));
  });
}

/** Fingerprint, issuer and host name from the text of svn's interactive certificate prompt (when available). */
export function parseSvnCertificateText(text: string): Partial<CertInfo> {
  const get = (re: RegExp): string | undefined => re.exec(text)?.[1]?.trim();
  const fp = get(/Fingerprint:\s*([0-9A-F:]{20,})/i);
  return {
    fingerprint: fp ? normalizeFingerprint(fp) : undefined,
    issuer: get(/Issuer:\s*(.+)/i),
    subject: get(/Hostname:\s*(.+)/i),
    validFrom: get(/Valid from\s*:?\s*([^\r\n]+?)(?:\s+until|\r?\n|$)/i),
    validTo: get(/until\s*:?\s*([^\r\n]+)/i),
  };
}

export type PinState = 'unpinned' | 'match' | 'changed';

export function pinState(pinned: string | undefined, live: string): PinState {
  if (!pinned) return 'unpinned';
  return sameFingerprint(pinned, live) ? 'match' : 'changed';
}

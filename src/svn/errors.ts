export type SvnErrorKind =
  | 'svnNotFound'
  | 'auth'
  | 'certificate'
  | 'offline'
  | 'conflict'
  | 'locked'
  | 'notWorkingCopy'
  | 'cancelled'
  | 'timeout'
  | 'parse'
  | 'untrusted'
  | 'unknown';

export class SvnError extends Error {
  constructor(
    public readonly kind: SvnErrorKind,
    message: string,
    public readonly exitCode: number | null = null,
    /** Already redacted. */
    public readonly stderr: string = '',
    /** Subversion error codes found in stderr, e.g. E170013. */
    public readonly codes: string[] = [],
  ) {
    super(message);
    this.name = 'SvnError';
  }
}

const CODE_RULES: Array<{ kind: SvnErrorKind; codes: string[]; text?: RegExp }> = [
  { kind: 'certificate', codes: ['E230001'], text: /server certificate verification failed/i },
  { kind: 'auth', codes: ['E170001', 'E215004', 'E215003', 'E175013'], text: /authentication failed|authorization failed|no more credentials|forbidden/i },
  { kind: 'offline', codes: ['E170013', 'E731001', 'E731004', 'E175002'], text: /unable to connect|could not resolve|connection refused|network is unreachable|timed out/i },
  { kind: 'notWorkingCopy', codes: ['E155007', 'E155036'], text: /is not a working copy/i },
  { kind: 'conflict', codes: ['E155015', 'E155035', 'E200024'], text: /conflict/i },
  { kind: 'locked', codes: ['E155004', 'E195022', 'E160035'], text: /\blocked\b/i },
];

export function extractCodes(stderr: string): string[] {
  return [...new Set(stderr.match(/\bE\d{6}\b/g) ?? [])];
}

export function classifyStderr(stderr: string): { kind: SvnErrorKind; codes: string[] } {
  const codes = extractCodes(stderr);
  // A code match wins; text matching is only a fallback.
  for (const r of CODE_RULES) {
    if (r.codes.some((c) => codes.includes(c))) return { kind: r.kind, codes };
  }
  for (const r of CODE_RULES) {
    if (r.text?.test(stderr)) return { kind: r.kind, codes };
  }
  return { kind: 'unknown', codes };
}

export function firstErrorLine(stderr: string): string {
  const line = stderr.split(/\r?\n/).find((l) => /svn: (E\d+|warning)/.test(l)) ?? stderr.trim().split(/\r?\n/)[0];
  return line?.trim() || 'svn command failed';
}

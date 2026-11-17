const SECRET_FLAGS = new Set(['--password']);

/** Returns a copy of svn args safe to log: values after --password are masked. */
export function redactArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (SECRET_FLAGS.has(a)) {
      out.push(a);
      if (i + 1 < args.length) {
        out.push('********');
        i++;
      }
    } else if (a.startsWith('--password=')) {
      out.push('--password=********');
    } else {
      out.push(redactUrlCredentials(a));
    }
  }
  return out;
}

/** Masks user:pass@ in URLs. */
export function redactUrlCredentials(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]*)@/gi, '$1$2:********@');
}

/** Masks any occurrence of the given secret values in free text (stderr, etc.). */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let out = redactUrlCredentials(text);
  for (const s of secrets) {
    if (s) out = out.split(s).join('********');
  }
  return out;
}

export function quoteForLog(args: readonly string[]): string {
  return redactArgs(args)
    .map((a) => (/[\s"]/.test(a) ? `"${a}"` : a))
    .join(' ');
}

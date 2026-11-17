import { withTempFile } from './tempFile';

// svn.exe reads --targets files in the Windows ANSI code page, not UTF-8, so non-ASCII paths in a UTF-8 list are
// "not under version control". The command line is UTF-16 and safe, so those paths go there instead.
const MAX_INLINE_CHARS = 20_000;

const isAscii = (t: string): boolean => [...t].every((ch) => ch.charCodeAt(0) < 128);

export function splitTargets(targets: readonly string[]): { listed: string[]; inline: string[] } {
  const listed: string[] = [];
  const inline: string[] = [];
  for (const t of targets) (isAscii(t) ? listed : inline).push(t);
  if (inline.reduce((n, t) => n + t.length + 1, 0) > MAX_INLINE_CHARS) throw new Error('Too many paths with non-ASCII characters for one svn command; select fewer items.');
  return { listed, inline };
}

/** Trailing svn arguments for the given (already peg-safe) targets; `fn` must append them last. */
export async function withTargetArgs<T>(dir: string, targets: readonly string[], fn: (args: string[]) => Promise<T>): Promise<T> {
  const { listed, inline } = splitTargets(targets);
  const tail = inline.length ? ['--', ...inline] : [];
  if (!listed.length) return fn(tail);
  return withTempFile(dir, listed.join('\n') + '\n', (file) => fn(['--targets', file, ...tail]));
}

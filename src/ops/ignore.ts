/** Pure helpers for the svn:ignore property (newline separated glob patterns). */

export function parseIgnoreList(value: string): string[] {
  return value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

export function formatIgnoreList(entries: readonly string[]): string {
  return entries.join('\n');
}

/** Escapes glob metacharacters so a literal file name matches only itself. */
export function escapeGlob(name: string): string {
  return name.replace(/[\\*?[\]]/g, (c) => `\\${c}`);
}

/** `*.ext` for a file with an extension; undefined for folders, dotfiles without extension or no extension. */
export function extensionPattern(name: string): string | undefined {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? `*${escapeGlob(name.slice(i))}` : undefined;
}

export interface MergeResult {
  entries: string[];
  added: string[];
  alreadyPresent: string[];
}

/** Adds patterns to an existing list without duplicates, preserving order. */
export function mergeIgnore(existing: readonly string[], patterns: readonly string[]): MergeResult {
  const entries = [...existing];
  const added: string[] = [];
  const alreadyPresent: string[] = [];
  for (const p of patterns) {
    if (entries.includes(p) || added.includes(p)) alreadyPresent.push(p);
    else {
      entries.push(p);
      added.push(p);
    }
  }
  return { entries, added, alreadyPresent };
}

export function removeIgnore(existing: readonly string[], patterns: readonly string[]): string[] {
  const drop = new Set(patterns);
  return existing.filter((e) => !drop.has(e));
}

/** Minimal fnmatch (`*`, `?`, `[...]`, backslash escape) as used by svn:ignore. */
export function globMatches(pattern: string, name: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 2);
      if (end < 0) re += '\\[';
      else {
        const body = pattern.slice(i + 1, end).replace(/^[!^]/, '^').replace(/\\/g, '\\\\');
        re += `[${body}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  try {
    return new RegExp(`^${re}$`).test(name);
  } catch {
    return false;
  }
}

import { isSameOrUnder, pathKey } from '../incoming/model';

/** Drops duplicates and any path lying beneath another selected path (a folder covers its contents). */
export function dedupeNested(paths: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const p of paths) unique.set(pathKey(p), p);
  const all = [...unique.values()];
  return all.filter((p) => !all.some((q) => q !== p && pathKey(q) !== pathKey(p) && isSameOrUnder(p, q)));
}

/** Groups targets by repo name, deduping nested paths per repo. */
export function groupPathsByRepo<T extends { repo: { name: string }; fsPath: string }>(targets: readonly T[]): Map<string, { repo: T['repo']; paths: string[] }> {
  const raw = new Map<string, { repo: T['repo']; paths: string[] }>();
  for (const t of targets) {
    const g = raw.get(t.repo.name) ?? { repo: t.repo, paths: [] as string[] };
    g.paths.push(t.fsPath);
    raw.set(t.repo.name, g);
  }
  for (const g of raw.values()) g.paths = dedupeNested(g.paths);
  return raw;
}

/** "Committed revision 12." -> 12 */
export function parseCommittedRevision(text: string): number | undefined {
  const m = /Committed revision (\d+)/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

/** Conflict lines of `svn update` output (`C  path`, also tree conflicts). */
export function parseUpdateConflicts(text: string): string[] {
  const re = /^[ ADUCGEMR]{0,3}C\s+(\S.*)$/;
  return text.split(/\r?\n/).map((l) => re.exec(l)?.[1]).filter((p): p is string => !!p);
}

export function parseUpdatedRevision(text: string): number | undefined {
  const m = /(?:Updated to|At) revision (\d+)/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

export function summarizePaths(paths: readonly string[], rel: (p: string) => string, max = 15): string {
  const shown = paths.slice(0, max).map((p) => `  ${rel(p)}`);
  if (paths.length > max) shown.push(`  ... and ${paths.length - max} more`);
  return shown.join('\n');
}

import type { Logger } from './logger';

/**
 * Menu "when" clauses test `resourcePath in <key>`; VS Code keeps these arrays in memory and re-sends them on every
 * change. 200k paths measured at about 8 MB and ~140 ms to serialize, which is acceptable; beyond that the menu entries
 * for the remaining paths are hidden (commands still work from the pane, and the command guard is the real check).
 */
export const MAX_PATH_KEYS = 200_000;

const warned = new Set<string>();

export function capPathKeys(key: string, paths: string[], log?: Logger, max = MAX_PATH_KEYS): string[] {
  if (paths.length <= max) {
    warned.delete(key);
    return paths;
  }
  if (!warned.has(key)) {
    warned.add(key);
    log?.warn(`${key}: ${paths.length} paths exceed the context-key limit of ${max}; menu entries are hidden for the rest (commands from the SVN pane still work).`);
  }
  return paths.slice(0, max);
}

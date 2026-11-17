import * as nodeFs from 'node:fs';
import * as path from 'node:path';

/** The slice of node:fs the root search needs (replaceable in tests). */
export interface DirApi {
  hasSvnDir(dir: string): boolean;
}

export const nodeDirApi: DirApi = {
  hasSvnDir(dir) {
    try {
      return nodeFs.statSync(path.join(dir, '.svn')).isDirectory();
    } catch {
      return false;
    }
  },
};

/** Nearest folder at or above `start` that contains `.svn` (the working copy root since svn 1.7), or undefined. */
export function findWcRootUp(start: string, api: DirApi = nodeDirApi): string | undefined {
  let cur = path.resolve(start);
  for (;;) {
    if (api.hasSvnDir(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

import { PathFlavour, isSameOrUnder } from './model';

/** The workspace folder to show: the one holding the active file, else the first. */
export function focusFolder(workspaceFolders: readonly string[], activeFile?: string, o: PathFlavour = {}): string | undefined {
  if (activeFile) {
    const holders = workspaceFolders.filter((w) => isSameOrUnder(activeFile, w, o));
    if (holders.length) return holders.reduce((a, b) => (b.length > a.length ? b : a));
  }
  return workspaceFolders[0];
}

export interface ScopePick {
  name: string;
  /** Folder passed to svn status: the focus folder when it lies inside the working copy, else the working copy root. */
  target: string;
}

/**
 * The single repository the pane shows: the working copy containing the focus folder (innermost wins,
 * target = the focus folder), or else the first working copy found inside the focus folder (target = its root).
 */
export function pickScope(repos: readonly { name: string; localFolder: string }[], focus: string | undefined, o: PathFlavour = {}): ScopePick | undefined {
  if (!focus) return undefined;
  const containing = repos.filter((r) => isSameOrUnder(focus, r.localFolder, o));
  if (containing.length) {
    const r = containing.reduce((a, b) => (b.localFolder.length > a.localFolder.length ? b : a));
    return { name: r.name, target: focus };
  }
  const inside = repos.find((r) => isSameOrUnder(r.localFolder, focus, o));
  return inside ? { name: inside.name, target: inside.localFolder } : undefined;
}

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WcDbWatcherOptions {
  /** Working copy root; `<root>/.svn/wc.db` is watched. */
  folder: string;
  /** Settle time after the last change before reporting. */
  debounceMs?: number;
  /** True while one of our own operations (or a refresh) is running or has just ended; such changes are ignored. */
  isOwnActivity: () => boolean;
  onExternalChange: () => void;
  /** Test seam: modification time of wc.db, or undefined if unreadable. */
  mtime?: (file: string) => number | undefined;
}

const defaultMtime = (file: string): number | undefined => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
};

/**
 * Detects svn operations done outside the extension (TortoiseSVN, the command line, another editor) by
 * watching the working copy database. A change counts only when its mtime moved and none of our own
 * activity explains it; the report is debounced because one svn command writes the file several times.
 */
export class WcDbWatcher {
  private watcher?: fs.FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private last: number | undefined;
  private readonly file: string;
  private readonly mtime: (file: string) => number | undefined;

  constructor(private readonly o: WcDbWatcherOptions) {
    this.file = path.join(o.folder, '.svn', 'wc.db');
    this.mtime = o.mtime ?? defaultMtime;
    this.last = this.mtime(this.file);
  }

  start(): void {
    try {
      this.watcher = fs.watch(path.dirname(this.file), { persistent: false }, (_ev, name) => {
        if (!name || name === 'wc.db' || name.startsWith('wc.db-')) this.notify();
      });
      this.watcher.on('error', () => this.stop());
    } catch {
      // No .svn folder (not a working copy yet) or an unwatchable path: nothing to do.
    }
  }

  /** A filesystem event for the database arrived. */
  notify(): void {
    const m = this.mtime(this.file);
    if (m === undefined || m === this.last) return;
    this.last = m;
    if (this.o.isOwnActivity()) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.o.isOwnActivity()) this.o.onExternalChange();
    }, this.o.debounceMs ?? 1500);
    this.timer.unref?.();
  }

  private stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }

  dispose(): void {
    this.stop();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

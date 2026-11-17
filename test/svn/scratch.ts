import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRATCH_ROOT = 'F:\\TrashCache';

/** `<F:\TrashCache>\<name>\run-<pid>-<ts>`: a folder no other run (or test file) shares. */
export function runDir(name: string): string {
  return path.join(SCRATCH_ROOT, name, `run-${process.pid}-${Date.now()}`);
}

/** Removes a folder tree; svn working copies hold read-only files that fs.rmSync cannot delete on Windows. Also drops the then-empty parent. */
export function rmTree(dir: string): void {
  if (fs.existsSync(dir)) {
    if (process.platform === 'win32') spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', dir], { stdio: 'ignore', timeout: 120_000 });
    else fs.rmSync(dir, { recursive: true, force: true });
  }
  try {
    fs.rmdirSync(path.dirname(dir));
  } catch {
    // Not empty: other runs are still using it.
  }
}

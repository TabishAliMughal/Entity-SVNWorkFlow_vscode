import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { BackupInfo, listBackups } from './backup';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Removes leftovers in the extension's scratch folder (message and property files that a crash left behind).
 * Files younger than `minAgeMs` are kept: another VS Code window may be using them right now.
 */
export async function cleanTmp(dir: string, now = Date.now(), minAgeMs = 60 * 60 * 1000): Promise<number> {
  let removed = 0;
  for (const name of await fsp.readdir(dir).catch(() => [] as string[])) {
    const p = path.join(dir, name);
    try {
      const st = await fsp.stat(p);
      if (now - st.mtimeMs < minAgeMs) continue;
      await fsp.rm(p, { recursive: true, force: true });
      removed++;
    } catch {
      // in use or already gone
    }
  }
  return removed;
}

/** Override backups that never reached a successful commit and are older than `days` (0 = never ask). */
export async function staleBackups(root: string, days: number, now = Date.now()): Promise<BackupInfo[]> {
  if (!(days > 0)) return [];
  return (await listBackups(root)).filter((b) => !b.manifest.completed && now - Date.parse(b.manifest.createdAt) > days * DAY_MS);
}

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Writes `contents` (UTF-8, no BOM, exact bytes) to a fresh file in `dir`, runs `fn(file)` and always deletes
 * the file. Used to hand multi-line values (commit messages, property values) to svn with -F instead of argv.
 */
export async function withTempFile<T>(dir: string, contents: string, fn: (file: string) => Promise<T>): Promise<T> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `svn-${crypto.randomBytes(8).toString('hex')}.tmp`);
  await fs.writeFile(file, contents, { encoding: 'utf8', mode: 0o600 });
  try {
    return await fn(file);
  } finally {
    await fs.rm(file, { force: true });
  }
}

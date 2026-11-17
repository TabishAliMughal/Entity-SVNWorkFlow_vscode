import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ShelfMeta, parseShelfMeta, slug } from './model';

/** Patch-based shelves on disk: `<root>/<repo>/<shelf>/{shelf.json, shelf.patch, files/<rel>}`. */
export class ShelfStore {
  constructor(private readonly root: string) {}

  dir(repoName: string, name: string): string {
    return path.join(this.root, slug(repoName), slug(name));
  }

  patchPath(repoName: string, name: string): string {
    return path.join(this.dir(repoName, name), 'shelf.patch');
  }

  filePath(repoName: string, name: string, rel: string): string {
    return path.join(this.dir(repoName, name), 'files', ...rel.split('/'));
  }

  async exists(repoName: string, name: string): Promise<boolean> {
    return fs.stat(path.join(this.dir(repoName, name), 'shelf.json')).then(() => true, () => false);
  }

  async list(repoName: string): Promise<ShelfMeta[]> {
    const base = path.join(this.root, slug(repoName));
    const dirs = await fs.readdir(base).catch(() => [] as string[]);
    const out: ShelfMeta[] = [];
    for (const d of dirs) {
      try {
        out.push(parseShelfMeta(await fs.readFile(path.join(base, d, 'shelf.json'), 'utf8')));
      } catch {
        /* half-written or foreign folder */
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async read(repoName: string, name: string): Promise<ShelfMeta> {
    return parseShelfMeta(await fs.readFile(path.join(this.dir(repoName, name), 'shelf.json'), 'utf8'));
  }

  async readPatch(repoName: string, name: string): Promise<Buffer> {
    return fs.readFile(this.patchPath(repoName, name)).catch(() => Buffer.alloc(0));
  }

  /** Writes patch and binaries first and the metadata last, so a crash never leaves a listed but incomplete shelf. */
  async write(meta: ShelfMeta, patch: Buffer, binaries: ReadonlyMap<string, string>): Promise<void> {
    const dir = this.dir(meta.repoName, meta.name);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'shelf.patch'), patch);
    for (const [rel, src] of binaries) {
      const dest = this.filePath(meta.repoName, meta.name, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
    }
    await fs.writeFile(path.join(dir, 'shelf.json'), JSON.stringify(meta, null, 2), 'utf8');
  }

  async delete(repoName: string, name: string): Promise<void> {
    await fs.rm(this.dir(repoName, name), { recursive: true, force: true });
  }
}

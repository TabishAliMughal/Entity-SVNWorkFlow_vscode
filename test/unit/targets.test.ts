import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitTargets, withTargetArgs } from '../../src/util/targets';

describe('svn target lists (svn reads --targets files in the ANSI code page)', () => {
  it('keeps ASCII paths in the list file and passes non-ASCII paths on the command line', () => {
    const r = splitTargets(['C:\\a b\\c.txt', 'C:\\caf\u00e9\\x.txt', 'C:\\at@x.txt@']);
    expect(r.listed).toEqual(['C:\\a b\\c.txt', 'C:\\at@x.txt@']);
    expect(r.inline).toEqual(['C:\\caf\u00e9\\x.txt']);
  });

  it('builds trailing args with the list file first and inline targets after --', async () => {
    const dir = fs.mkdtempSync(path.join('F:/TrashCache', 'targets-'));
    try {
      let seen: string[] = [];
      await withTargetArgs(dir, ['a.txt', 'caf\u00e9.txt'], async (args) => {
        seen = args;
        expect(fs.readFileSync(args[1], 'utf8')).toBe('a.txt\n');
      });
      expect(seen.slice(0, 1)).toEqual(['--targets']);
      expect(seen.slice(2)).toEqual(['--', 'caf\u00e9.txt']);
      expect(await withTargetArgs(dir, ['caf\u00e9.txt'], async (a) => a)).toEqual(['--', 'caf\u00e9.txt']);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an unreasonable number of non-ASCII paths', () => {
    expect(() => splitTargets(Array.from({ length: 3000 }, (_, i) => `C:\\\u00e9\\file-${i}.txt`))).toThrow(/Too many/);
  });
});

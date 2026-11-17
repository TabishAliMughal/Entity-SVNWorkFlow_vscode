import { describe, expect, it } from 'vitest';
import { resolveRepo } from '../../src/repos/resolver';

const repos = [
  { name: 'a', serverUrl: 'svn://h/a', localFolder: 'C:\\work\\a' },
  { name: 'a-sub', serverUrl: 'svn://h/b', localFolder: 'C:\\work\\a\\sub' },
];

describe('resolveRepo (harness smoke test)', () => {
  it('uses longest prefix, case-insensitive on win32', () => {
    expect(resolveRepo('c:\\WORK\\a\\sub\\x.php', repos, { platform: 'win32' })?.name).toBe('a-sub');
    expect(resolveRepo('C:\\work\\a\\y.php', repos, { platform: 'win32' })?.name).toBe('a');
    expect(resolveRepo('C:\\work\\ab\\y.php', repos, { platform: 'win32' })).toBeUndefined();
  });
});

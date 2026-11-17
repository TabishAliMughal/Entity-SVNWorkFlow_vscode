import { describe, expect, it } from 'vitest';
import { RepoLocks } from '../../src/override/commitLocks';
import { acquireRepoLocks } from '../../src/wc/lock';
import {
  cleanupArgs, copyName, deriveRepoName, junkEntries, pairMoves, parseListAll, parseListDirs, parseLockedPaths, parseRevisionInput,
  planRevert, rebaseUrl, resolveSvnUrl, revertOrder, revertable, uniqueName, validateRelativeName,
} from '../../src/wc/model';

import { pathKey as key } from '../../src/incoming/model';

describe('names and urls', () => {
  it('derives repo names', () => {
    expect(deriveRepoName('https://h/svn/project/trunk')).toBe('project');
    expect(deriveRepoName('svn://127.0.0.1:13690/alpha')).toBe('alpha');
    expect(deriveRepoName('https://h/svn/proj/branches/b1')).toBe('proj');
    expect(deriveRepoName('https://myhost/')).toBe('myhost');
  });
  it('makes names unique', () => {
    expect(uniqueName('a', ['A', 'a-2'])).toBe('a-3');
    expect(uniqueName('b', ['a'])).toBe('b');
  });
  it('resolves ^/ and rebases URLs', () => {
    expect(resolveSvnUrl('^/branches/x', 'svn://h/r/')).toBe('svn://h/r/branches/x');
    expect(resolveSvnUrl('SVN://H/r/trunk/', 'svn://h/r')).toBe('svn://h/r/trunk');
    expect(rebaseUrl('svn://h/r/trunk', 'svn://h/r/trunk', 'svn://n/r/trunk')).toBe('svn://n/r/trunk');
    expect(rebaseUrl('svn://h/r/trunk/sub', 'svn://h/r/trunk', 'svn://n/x')).toBe('svn://n/x/sub');
    expect(rebaseUrl('svn://other/z', 'svn://h/r', 'svn://n/r')).toBe('svn://n/r');
  });
  it('parses svn list', () => {
    expect(parseListDirs('b1/\nb2/\nreadme.txt\n')).toEqual(['b1', 'b2']);
    expect(parseListAll('a/\nf.txt\r\n')).toEqual([{ name: 'a', dir: true }, { name: 'f.txt', dir: false }]);
  });
});

describe('input validation', () => {
  it('revisions', () => {
    expect(parseRevisionInput('r12')).toEqual({ ok: true, rev: '12' });
    expect(parseRevisionInput('head')).toEqual({ ok: true, rev: 'HEAD' });
    expect(parseRevisionInput('{2024-05-31}').ok).toBe(true);
    expect(parseRevisionInput('abc').ok).toBe(false);
    expect(parseRevisionInput('').ok).toBe(false);
  });
  it('relative names', () => {
    expect(validateRelativeName('a.txt')).toBeUndefined();
    expect(validateRelativeName('sub/a.txt')).toBeUndefined();
    expect(validateRelativeName('')).toBeTruthy();
    expect(validateRelativeName('C:/x')).toBeTruthy();
    expect(validateRelativeName('a?b')).toBeTruthy();
    expect(validateRelativeName('../a')).toBeTruthy();
    expect(validateRelativeName('../a', { allowParent: true })).toBeUndefined();
    expect(copyName('a.txt')).toBe('a copy.txt');
    expect(copyName('dir')).toBe('dir copy');
  });
});

describe('revert planning', () => {
  const all = [
    { path: 'C:/w/d', item: 'added', isDir: true },
    { path: 'C:/w/d/x.txt', item: 'added' },
    { path: 'C:/w/d/y.txt', item: 'added' },
    { path: 'C:/w/m.txt', item: 'modified' },
  ];
  it('filters non revertable entries', () => {
    expect(revertable([{ path: 'a', item: 'unversioned' }, { path: 'b', item: 'normal', props: 'modified' }, { path: 'c', item: 'missing' }, { path: 'd', item: 'ignored' }]).map((e) => e.path)).toEqual(['b', 'c']);
  });
  it('recursive only when all children selected', () => {
    const everything = new Set(all.map((a) => key(a.path)));
    expect(planRevert(all, everything).map((s) => [s.path, s.recursive])).toEqual([['C:/w/d', true], ['C:/w/m.txt', false]]);
    const partial = new Set([key('C:/w/d'), key('C:/w/d/x.txt')]);
    expect(planRevert(all, partial)).toEqual([{ path: 'C:/w/d', recursive: false }, { path: 'C:/w/d/x.txt', recursive: false }]);
    expect(revertOrder(planRevert(all, partial))[0].path).toBe('C:/w/d/x.txt');
  });
});

describe('cleanup helpers', () => {
  it('builds args', () => {
    expect(cleanupArgs({ vacuumPristines: false, includeExternals: false }, ['p'])).toEqual(['cleanup', '--', 'p']);
    expect(cleanupArgs({ vacuumPristines: true, includeExternals: true }, ['p'])).toEqual(['cleanup', '--vacuum-pristines', '--include-externals', '--', 'p']);
  });
  it('folds nested junk and honours kinds', () => {
    const e = [{ path: 'C:/w/d', item: 'unversioned' }, { path: 'C:/w/d/i.log', item: 'ignored' }, { path: 'C:/w/o.log', item: 'ignored' }, { path: 'C:/w/m', item: 'modified' }];
    expect(junkEntries(e, { unversioned: true, ignored: true }).map((x) => x.path)).toEqual(['C:/w/d', 'C:/w/o.log']);
    expect(junkEntries(e, { unversioned: false, ignored: true }).map((x) => x.path)).toEqual(['C:/w/d/i.log', 'C:/w/o.log']);
  });
  it('finds locked entries in status xml', () => {
    const xml = '<status><target path="."><entry path="a &amp; b.txt"><wc-status item="normal"><lock><token>t</token></lock></wc-status></entry><entry path="c.txt"><wc-status item="normal"/></entry></target></status>';
    expect(parseLockedPaths(xml)).toEqual(['a & b.txt']);
  });
});

describe('move pairing', () => {
  it('pairs by content, prefers same basename, leaves deletes', () => {
    const plan = pairMoves(
      [{ path: '/w/a.txt', size: 3, hash: 'h1' }, { path: '/w/b.txt', size: 3, hash: 'h1' }, { path: '/w/gone.txt', size: 5, hash: 'h9' }],
      [{ path: '/w/n/b.txt', size: 3, hash: 'h1' }, { path: '/w/n/zz.txt', size: 3, hash: 'h1' }],
    );
    expect(plan.moves).toEqual([{ from: '/w/b.txt', to: '/w/n/b.txt' }, { from: '/w/a.txt', to: '/w/n/zz.txt' }]);
    expect(plan.moves.find((m) => m.from === '/w/b.txt')?.to).toBe('/w/n/b.txt');
    expect(plan.moves).toHaveLength(2);
    expect(plan.deletes).toEqual(['/w/gone.txt']);
  });
});

describe('repo locks', () => {
  it('acquires all or none', () => {
    const locks = new RepoLocks();
    const a = acquireRepoLocks(['x', 'y'], locks);
    expect('release' in a).toBe(true);
    expect(acquireRepoLocks(['z', 'X'], locks)).toEqual({ busy: 'X' });
    expect(locks.isBusy('z')).toBe(false);
    if ('release' in a) a.release();
    expect(locks.isBusy('x')).toBe(false);
    expect('release' in acquireRepoLocks(['x', 'x'], locks)).toBe(true);
  });
});

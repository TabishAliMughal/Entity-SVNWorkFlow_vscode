import { describe, expect, it } from 'vitest';
import { LockCache } from '../../src/locks/cache';
import { describeLock, lockBadge, lockView, needsLockPrompt } from '../../src/locks/model';
import { ExternalDef, formatExternal, formatExternals, parseExternalLine, parseExternals, tokenize, validateExternal } from '../../src/props/externals';
import { normalizeLines, parseKeywords, propAppliesTo, validateChange, validatePropName } from '../../src/props/model';
import { StatusEntry } from '../../src/svn/xml';

describe('svn:externals', () => {
  it('tokenizes quotes and escapes', () => {
    expect(tokenize('a "b c" d\\ e')).toEqual(['a', 'b c', 'd e']);
    expect(tokenize("'x y'  z")).toEqual(['x y', 'z']);
  });
  it('parses the svn 1.5+ format', () => {
    expect(parseExternalLine('svn://h/r/lib@12 libs/lib')).toEqual({ url: 'svn://h/r/lib', peg: '12', rev: undefined, dir: 'libs/lib' });
    expect(parseExternalLine('-r 5 ^/common/x common')).toEqual({ url: '^/common/x', peg: undefined, rev: '5', dir: 'common' });
    expect(parseExternalLine('-r5 https://h/s/x@HEAD "my dir"')).toMatchObject({ rev: '5', peg: 'HEAD', dir: 'my dir' });
    expect(parseExternalLine('https://user@host/svn/x dir')).toMatchObject({ url: 'https://user@host/svn/x', peg: undefined });
  });
  it('parses the old format (dir first)', () => {
    expect(parseExternalLine('old-dir -r7 http://h/r/x')).toEqual({ url: 'http://h/r/x', peg: undefined, rev: '7', dir: 'old-dir' });
  });
  it('round trips and keeps comments', () => {
    const text = '# libs\n-r5 svn://h/r/a@3 "dir with space"\n^/x y\nbroken\n';
    const p = parseExternals(text);
    expect(p.defs).toHaveLength(2);
    expect(p.other).toEqual(['# libs', 'broken']);
    const out = formatExternals(p.defs, p.other);
    expect(parseExternals(out)).toEqual(p);
    expect(out.endsWith('\n')).toBe(true);
    expect(formatExternals([])).toBe('');
  });
  it('formats and validates rows', () => {
    const d: ExternalDef = { url: 'svn://h/r', peg: '9', dir: 'a b' };
    expect(formatExternal(d)).toBe('svn://h/r@9 "a b"');
    expect(validateExternal(d)).toEqual([]);
    expect(validateExternal({ url: '', dir: '' }).length).toBe(2);
    expect(validateExternal({ url: 'foo', dir: 'x' })[0]).toMatch(/absolute/);
    expect(validateExternal({ url: 'svn://h', dir: '../x' })[0]).toMatch(/relative/);
    expect(validateExternal({ url: 'svn://h', dir: 'x', peg: 'abc' })[0]).toMatch(/Peg/);
  });
});

describe('property model', () => {
  it('validates names and changes', () => {
    expect(validatePropName('svn:ignore')).toBeUndefined();
    expect(validatePropName('my-prop.1')).toBeUndefined();
    expect(validatePropName('-bad')).toBeTruthy();
    expect(validatePropName('a b')).toBeTruthy();
    expect(validateChange({ name: 'svn:ignore', value: 'x' }, false)).toMatch(/cannot be set on a file/);
    expect(validateChange({ name: 'svn:executable', value: '*' }, true)).toMatch(/cannot be set on a folder/);
    expect(validateChange({ name: 'svn:eol-style', value: 'weird' }, false)).toMatch(/eol-style/);
    expect(validateChange({ name: 'svn:eol-style', value: 'LF' }, false)).toBeUndefined();
    expect(validateChange({ name: 'custom:x', value: 'a\nb' }, true)).toBeUndefined();
    expect(propAppliesTo('custom:x', false)).toBe(true);
  });
  it('normalizes lists and keywords', () => {
    expect(normalizeLines('a\r\n\n b \n')).toBe('a\nb\n');
    expect(normalizeLines('')).toBe('');
    expect(parseKeywords('Id, Date  Rev')).toEqual(['Id', 'Date', 'Rev']);
  });
});

describe('lock model', () => {
  const me = { token: 't1', owner: 'me', comment: 'c', created: '2026-01-01T00:00:00Z' };
  it('combines working copy and server locks', () => {
    expect(lockView(undefined, undefined, true).state).toBe('none');
    expect(lockView(me, me, true).state).toBe('mine');
    expect(lockView(me, undefined, false).state).toBe('mine');
    expect(lockView(me, undefined, true).state).toBe('stale');
    expect(lockView(undefined, { token: 'x', owner: 'bob' }, true).state).toBe('other');
    expect(lockView(me, { token: 'x', owner: 'bob' }, true)).toMatchObject({ state: 'other', info: { owner: 'bob' } });
  });
  it('describes and badges', () => {
    expect(describeLock(lockView(undefined, { token: 'x', owner: 'bob', comment: 'fixing' }, true))).toMatch(/by bob.*fixing/);
    expect(lockBadge({ state: 'none' })).toBeUndefined();
    expect(lockBadge({ state: 'mine' })).toBe('L');
  });
  it('prompts only for read-only needs-lock files without my lock', () => {
    expect(needsLockPrompt({ needsLock: true, readOnly: true, state: 'none' })).toBe(true);
    expect(needsLockPrompt({ needsLock: true, readOnly: true, state: 'mine' })).toBe(false);
    expect(needsLockPrompt({ needsLock: true, readOnly: false, state: 'none' })).toBe(false);
    expect(needsLockPrompt({ needsLock: false, readOnly: true, state: 'none' })).toBe(false);
  });
  it('caches locks from status runs', () => {
    const cache = new LockCache();
    const entry = (p: string, lock?: StatusEntry['lock'], repoLock?: StatusEntry['repoLock']): StatusEntry => ({ path: p, item: 'normal', props: 'none', wcLocked: false, lock, repoLock });
    cache.update('r', 'C:\\wc', [entry('a.txt', me, me), entry('b.txt', undefined, { token: 'x', owner: 'bob' })], true);
    expect(cache.get('r', 'C:\\wc\\a.txt').state).toBe('mine');
    expect(cache.get('r', 'c:\\WC\\b.txt').state).toBe('other');
    // a local-only run keeps the server locks and refreshes local tokens
    cache.update('r', 'C:\\wc', [], false);
    expect(cache.get('r', 'C:\\wc\\a.txt').state).toBe('none');
    expect(cache.get('r', 'C:\\wc\\b.txt').state).toBe('other');
    expect(cache.all('r')).toHaveLength(1);
    expect(cache.find('C:\\wc\\b.txt').info?.owner).toBe('bob');
  });
});

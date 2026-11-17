import { describe, expect, it } from 'vitest';
import { escapeGlob, extensionPattern, formatIgnoreList, globMatches, mergeIgnore, parseIgnoreList, removeIgnore } from '../../src/ops/ignore';

describe('svn:ignore helpers', () => {
  it('parses and formats lists', () => {
    expect(parseIgnoreList('a.log\r\n\n  build \n')).toEqual(['a.log', 'build']);
    expect(formatIgnoreList(['a', 'b'])).toBe('a\nb');
  });
  it('merges without duplicates', () => {
    const r = mergeIgnore(['*.log'], ['*.log', 'tmp', 'tmp']);
    expect(r.entries).toEqual(['*.log', 'tmp']);
    expect(r.added).toEqual(['tmp']);
    expect(r.alreadyPresent).toEqual(['*.log', 'tmp']);
  });
  it('removes entries', () => {
    expect(removeIgnore(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
  });
  it('escapes glob characters', () => {
    expect(escapeGlob('a[1]*.txt')).toBe(String.raw`a\[1\]\*.txt`);
  });
  it('builds extension patterns', () => {
    expect(extensionPattern('x.log')).toBe('*.log');
    expect(extensionPattern('archive.tar.gz')).toBe('*.gz');
    expect(extensionPattern('.env')).toBeUndefined();
    expect(extensionPattern('Makefile')).toBeUndefined();
    expect(extensionPattern('end.')).toBeUndefined();
  });
  it('matches globs', () => {
    expect(globMatches('*.log', 'a.log')).toBe(true);
    expect(globMatches('*.log', 'a.txt')).toBe(false);
    expect(globMatches('file?.txt', 'file1.txt')).toBe(true);
    expect(globMatches('[ab].c', 'a.c')).toBe(true);
    expect(globMatches(String.raw`a\[1\].txt`, 'a[1].txt')).toBe(true);
    expect(globMatches('a.b', 'aXb')).toBe(false);
  });
});

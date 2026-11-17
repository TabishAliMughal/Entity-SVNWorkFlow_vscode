import { describe, expect, it } from 'vitest';
import { classifyStderr, extractCodes, firstErrorLine } from '../../src/svn/errors';

const kind = (s: string) => classifyStderr(s).kind;

describe('classifyStderr', () => {
  it.each([
    ['svn: E170013: Unable to connect to a repository at URL\nsvn: E731001: No such host', 'offline'],
    ['svn: E230001: Server SSL certificate verification failed: self-signed certificate', 'certificate'],
    ['svn: E170001: Authentication failed', 'auth'],
    ['svn: E170001: Authorization failed', 'auth'],
    ["svn: E175013: Commit failed (details follow):\nsvn: E175013: Access to '/svn/a/!svn/me' forbidden", 'auth'],
    ['svn: E215004: No more credentials or we tried too many times.', 'auth'],
    ['svn: warning: W155007: x\nsvn: E155007: "C:\\x" is not a working copy', 'notWorkingCopy'],
    ['svn: E155015: Aborting commit: remains in conflict', 'conflict'],
    ['svn: E155004: Working copy is locked; run cleanup', 'locked'],
    ['svn: E999999: weird', 'unknown'],
  ])('%j -> %s', (s, k) => expect(kind(s)).toBe(k));

  it('text fallback without codes', () => {
    expect(kind('Authentication failed')).toBe('auth');
    expect(kind('Unable to connect to a repository')).toBe('offline');
    expect(kind('Server certificate verification failed')).toBe('certificate');
  });
  it('a code wins over text of another kind', () => {
    expect(kind('svn: E170013: Unable to connect\nauthentication failed')).toBe('offline');
  });
  it('extracts unique codes', () => {
    expect(extractCodes('E170013 E170013 E731001')).toEqual(['E170013', 'E731001']);
  });
  it('firstErrorLine', () => {
    expect(firstErrorLine('junk\nsvn: E170001: Authentication failed\nmore')).toBe('svn: E170001: Authentication failed');
    expect(firstErrorLine('')).toBe('svn command failed');
    expect(firstErrorLine('only line')).toBe('only line');
  });
});

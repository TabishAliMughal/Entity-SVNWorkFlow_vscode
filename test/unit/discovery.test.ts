import { describe, expect, it } from 'vitest';
import { findSvnExe, notFoundMessage } from '../../src/svn/discovery';
import { SvnLocator } from '../../src/svn/locator';
import { SvnError } from '../../src/svn/errors';

const TSVN = 'C:\\Program Files\\TortoiseSVN\\bin\\svn.exe';
const only = (...files: string[]) => (p: string) => files.includes(p);

describe('findSvnExe', () => {
  it('prefers the custom path when it is an exe', () => {
    const r = findSvnExe({ customPath: 'D:\\x\\svn.exe', env: {}, exists: only('D:\\x\\svn.exe', TSVN) });
    expect(r).toMatchObject({ path: 'D:\\x\\svn.exe', source: 'setting' });
  });
  it('accepts a folder and quoted custom path', () => {
    const r = findSvnExe({ customPath: '"D:\\x\\bin"', env: {}, exists: only('D:\\x\\bin\\svn.exe') });
    expect(r.path).toBe('D:\\x\\bin\\svn.exe');
  });
  it('falls back to TortoiseSVN when the custom path is bad', () => {
    const r = findSvnExe({ customPath: 'D:\\nope', env: { ProgramFiles: 'C:\\Program Files' }, exists: only(TSVN) });
    expect(r).toMatchObject({ path: TSVN, source: 'tortoiseSvn' });
    expect(r.tried[0]).toBe('D:\\nope');
  });
  it('checks ProgramFiles(x86)', () => {
    const x86 = 'D:\\PF86\\TortoiseSVN\\bin\\svn.exe';
    const r = findSvnExe({ env: { 'ProgramFiles(x86)': 'D:\\PF86' }, exists: only(x86) });
    expect(r.path).toBe(x86);
  });
  it('searches PATH last', () => {
    const r = findSvnExe({ env: { PATH: 'C:\\a;"D:\\tools"' }, exists: only('D:\\tools\\svn.exe') });
    expect(r).toMatchObject({ path: 'D:\\tools\\svn.exe', source: 'path' });
  });
  it('reports tried locations when nothing is found', () => {
    const r = findSvnExe({ customPath: 'Z:\\q', env: { PATH: 'C:\\a' }, exists: () => false });
    expect(r.path).toBeUndefined();
    expect(r.tried).toContain('PATH');
    expect(r.tried).toContain('Z:\\q');
    const msg = notFoundMessage(r, 'Z:\\q');
    expect(msg).toContain('"Z:\\q" does not point to svn.exe');
    expect(msg).toContain('svnWorkflow.svnPath');
    expect(msg).toContain('command line client tools');
  });
  it('omits the custom-path sentence when none is configured', () => {
    expect(notFoundMessage({ tried: [] })).not.toContain('configured path');
  });
});

describe('SvnLocator', () => {
  it('throws svnNotFound with guidance and does not cache failures', () => {
    let calls = 0;
    let found = undefined as string | undefined;
    const loc = new SvnLocator(
      () => 'Z:\\q',
      () => {
        calls++;
        return { path: found, tried: ['x'] };
      },
    );
    try {
      loc.getExe();
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SvnError);
      expect((e as SvnError).kind).toBe('svnNotFound');
      expect((e as SvnError).message).toContain('svnWorkflow.svnPath');
    }
    found = 'C:\\svn.exe';
    expect(loc.getExe()).toBe('C:\\svn.exe');
    expect(loc.getExe()).toBe('C:\\svn.exe');
    expect(calls).toBe(2);
  });
  it('invalidate() forces rediscovery', () => {
    let n = 0;
    const loc = new SvnLocator(() => '', () => ({ path: `C:\\svn${++n}.exe`, tried: [] }));
    expect(loc.getExe()).toBe('C:\\svn1.exe');
    loc.invalidate();
    expect(loc.getExe()).toBe('C:\\svn2.exe');
  });
});

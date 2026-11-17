import { describe, expect, it } from 'vitest';
import { findSvnExe } from '../../src/svn/discovery';
import { runProcess } from '../../src/svn/runner';
import { redactArgs } from '../../src/util/redact';

const svn = findSvnExe().path;

describe('harness smoke tests', () => {
  it('redacts passwords in args', () => {
    expect(redactArgs(['info', '--password', 'secret'])).toEqual(['info', '--password', '********']);
  });
  it.skipIf(!svn)('runs svn --version', async () => {
    const r = await runProcess(svn!, ['--version', '--quiet']);
    expect(r.text.trim()).toMatch(/^\d+\.\d+/);
  });
});

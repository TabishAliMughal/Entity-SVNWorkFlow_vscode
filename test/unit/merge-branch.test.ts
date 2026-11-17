import { describe, expect, it } from 'vitest';
import { buildCopyArgs, defaultMessage, detectLayout, refUrl, validateRefName } from '../../src/branch/model';
import { buildExportArgs, countExported, parseExportedRevision } from '../../src/export/model';
import { buildMergeArgs, compressRevs, eligibleEntries, parseMergeOutput, parseRevList, parseRevSpec, relToTarget, summarizeMerge } from '../../src/merge/model';

describe('mergeinfo parsing', () => {
  it('parses --show-revs output', () => {
    expect(parseRevList('r564\nr566\r\nr12\n\n')).toEqual([12, 564, 566]);
    expect(parseRevList('')).toEqual([]);
  });
  it('lists eligible revisions newest first with their log entries', () => {
    const out = eligibleEntries([5, 9, 7], [{ revision: 9, message: 'x' }, { revision: 5 }]);
    expect(out.map((e) => e.revision)).toEqual([9, 7, 5]);
    expect(out[0]).toMatchObject({ message: 'x' });
  });
});

describe('revision specs', () => {
  it('normalizes lists and ranges', () => {
    expect(parseRevSpec('5')).toEqual({ spec: '5', revs: [5] });
    expect(parseRevSpec('r9, 5 7 ; 10-11')).toMatchObject({ spec: '5,7,9-11' });
    expect(compressRevs([3, 1, 2, 2, 8])).toBe('1-3,8');
  });
  it('rejects bad input', () => {
    expect('error' in parseRevSpec('')).toBe(true);
    expect('error' in parseRevSpec('abc')).toBe(true);
    expect('error' in parseRevSpec('9-5')).toBe(true);
    expect('error' in parseRevSpec('0')).toBe(true);
  });
});

describe('merge arguments', () => {
  it('builds sync, range and reintegrate commands', () => {
    expect(buildMergeArgs({ kind: 'sync', source: 'U', target: '.' })).toEqual(['merge', '--accept', 'postpone', '--', 'U', '.']);
    expect(buildMergeArgs({ kind: 'range', source: 'U', target: '.', revs: '5,7-9', dryRun: true, recordOnly: true, ignoreAncestry: true, accept: 'theirs-full' })).toEqual([
      'merge', '--dry-run', '--record-only', '--ignore-ancestry', '-c', '5,7-9', '--accept', 'theirs-full', '--', 'U', '.',
    ]);
    expect(() => buildMergeArgs({ kind: 'range', source: 'U', target: '.' })).toThrow();
  });
});

describe('merge output parsing', () => {
  const out = [
    "--- Merging r558 through r566 into '.':",
    'U    a.txt',
    'U    d\\c.txt',
    'A    new.txt',
    'D    b.txt',
    'C    conflict.txt',
    "   C tree.txt",
    "Skipped missing target: 'gone.txt'",
    "--- Recording mergeinfo for merge of r558 through r566 into '.':",
    ' U   .',
    'Summary of conflicts:',
    '  Text conflicts: 1',
    '  Tree conflicts: 1',
    '  Skipped paths: 1',
  ].join('\n');
  it('collects changes, conflicts, skips and mergeinfo', () => {
    const r = parseMergeOutput(out);
    expect(r.changes.map((c) => `${c.action}${c.path}`)).toEqual(['Ua.txt', 'Ud\\c.txt', 'Anew.txt', 'Db.txt', 'Cconflict.txt', ' tree.txt']);
    expect(r.conflicts).toEqual(['conflict.txt', 'tree.txt']);
    expect(r.skipped).toEqual(['gone.txt']);
    expect(r.recordedMergeinfo).toBe(true);
    expect(summarizeMerge(r)).toBe('1 added, 1 deleted, 2 updated, 2 conflicts, 1 skipped');
  });
  it('drops conflicts that --accept resolved right away', () => {
    const r = parseMergeOutput("--- Merging r5 into '.':\nC    a.txt\nC    b.txt\nResolved conflicted state of 'a.txt'\nSummary of conflicts:\n  Text conflicts: 1 remaining (and 1 already resolved)\n");
    expect(r.conflicts).toEqual(['b.txt']);
  });
  it('handles empty and record-only output', () => {
    expect(summarizeMerge(parseMergeOutput(''))).toBe('no changes');
    expect(summarizeMerge(parseMergeOutput("--- Recording mergeinfo for merge of r5 into '.':\n U   .\n"))).toBe('mergeinfo recorded only');
  });
  it('makes paths relative to the target', () => {
    expect(relToTarget('C:\\wc\\a\\b.txt', 'C:\\wc')).toBe('a/b.txt');
    expect(relToTarget('b.txt', 'C:\\wc')).toBe('b.txt');
  });
});

describe('layout detection', () => {
  const root = 'svn://h/alpha';
  it('detects trunk, branch and tag at the root', () => {
    expect(detectLayout(root, `${root}/trunk`)).toMatchObject({ kind: 'trunk', base: root, branches: `${root}/branches`, tags: `${root}/tags` });
    expect(detectLayout(root, `${root}/branches/b1/src`)).toMatchObject({ kind: 'branch', name: 'b1', trunk: `${root}/trunk` });
    expect(detectLayout(root, `${root}/tags/v1`)).toMatchObject({ kind: 'tag', name: 'v1' });
  });
  it('finds a project base below the root', () => {
    const l = detectLayout(root, `${root}/proj/a/branches/x`);
    expect(l).toMatchObject({ kind: 'branch', name: 'x', base: `${root}/proj/a`, trunk: `${root}/proj/a/trunk` });
  });
  it('falls back to the root for non-standard URLs and honours custom names', () => {
    expect(detectLayout(root, `${root}/misc/dir`)).toMatchObject({ kind: 'other', base: root });
    const c = detectLayout(root, `${root}/p/release/r1`, { branches: 'release', trunk: 'main', tags: 'rel-tags' });
    expect(c).toMatchObject({ kind: 'branch', name: 'r1', trunk: `${root}/p/main`, tags: `${root}/p/rel-tags` });
    expect(detectLayout(root, `${root}/trunk`, { base: 'p' })).toMatchObject({ base: `${root}/p`, kind: 'other' });
    expect(detectLayout(`${root}/`, `${root}/trunk/`).kind).toBe('trunk');
  });
  it('builds ref URLs and validates names', () => {
    expect(refUrl(detectLayout(root, `${root}/trunk`), 'branch', 'feat/x')).toBe(`${root}/branches/feat/x`);
    expect(validateRefName('ok-1.0')).toBeUndefined();
    expect(validateRefName('feature/x')).toBeUndefined();
    for (const bad of ['', ' a', 'a/', '/a', 'a//b', '..', 'a/../b', 'a:b', 'a@b', 'a\\b']) expect(validateRefName(bad), bad).toBeTruthy();
    expect(defaultMessage('tag', 'v1', 'trunk')).toBe('Create tag v1 from trunk');
  });
  it('builds copy arguments with -F, never -m', () => {
    expect(buildCopyArgs({ kind: 'wc', path: 'C:\\wc' }, 'U/branches/b', 'm.tmp')).toEqual(['copy', '--parents', '-F', 'm.tmp', '--encoding', 'UTF-8', '--', 'C:\\wc', 'U/branches/b']);
    const a = buildCopyArgs({ kind: 'url', url: 'U/trunk', rev: 7 }, 'U/tags/t', 'm.tmp');
    expect(a).toContain('-r');
    expect(a).toContain('U/trunk@7');
    expect(buildCopyArgs({ kind: 'url', url: 'U/trunk', rev: 'HEAD' }, 'D', 'm').slice(-2)).toEqual(['U/trunk', 'D']);
    expect(a).not.toContain('-m');
  });
});

describe('export arguments', () => {
  it('builds options', () => {
    expect(buildExportArgs({ source: 'S', dest: 'D', depth: 'infinity', eol: 'default', ignoreExternals: false, force: false })).toEqual(['export', '--', 'S', 'D']);
    expect(buildExportArgs({ source: 'svn://h/r/U@5', dest: 'D', rev: 5, depth: 'files', eol: 'CRLF', ignoreExternals: true, force: true })).toEqual([
      'export', '-r', '5', '--depth', 'files', '--native-eol', 'CRLF', '--ignore-externals', '--force', '--', 'svn://h/r/U@5', 'D',
    ]);
    // local paths containing '@' get the trailing '@' svn needs (source and destination)
    expect(buildExportArgs({ source: 'C:\\wc@home\\f.txt', dest: 'C:\\out@1', depth: 'infinity', eol: 'default', ignoreExternals: false, force: false }).slice(-2)).toEqual(['C:\\wc@home\\f.txt@', 'C:\\out@1@']);
  });
  it('parses output', () => {
    expect(parseExportedRevision('A    x\nExported revision 12.\n')).toBe(12);
    expect(countExported('A    D/x\nA    D/y\nExported revision 3.\n')).toBe(2);
  });
});

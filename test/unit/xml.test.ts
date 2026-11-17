import { describe, expect, it } from 'vitest';
import { parseInfo, parseStatus } from '../../src/svn/xml';
import { SvnError } from '../../src/svn/errors';

const INFO = `<?xml version="1.0" encoding="UTF-8"?>
<info><entry path="." revision="7" kind="dir">
<url>svn://127.0.0.1:13690/alpha/trunk</url>
<repository><root>svn://127.0.0.1:13690/alpha</root><uuid>abc-123</uuid></repository>
<commit revision="5"><author>tester</author><date>2026-11-16T10:00:00.000000Z</date></commit>
</entry></info>`;

describe('parseInfo', () => {
  it('parses a full entry', () => {
    expect(parseInfo(INFO)).toEqual({
      path: '.',
      url: 'svn://127.0.0.1:13690/alpha/trunk',
      repositoryRoot: 'svn://127.0.0.1:13690/alpha',
      repositoryUuid: 'abc-123',
      revision: 7,
      nodeKind: 'dir',
      lastChangedRevision: 5,
      lastChangedAuthor: 'tester',
      lastChangedDate: '2026-11-16T10:00:00.000000Z',
    });
  });
  it('tolerates missing commit/repository', () => {
    const i = parseInfo('<info><entry path="x" revision="1" kind="file"><url>http://h/x</url></entry></info>');
    expect(i.lastChangedRevision).toBeUndefined();
    expect(i.repositoryRoot).toBe('');
  });
  it('throws a parse SvnError on garbage or missing url', () => {
    for (const bad of ['', '<info></info>', '<info><entry path="x"/></info>']) {
      try {
        parseInfo(bad);
        expect.unreachable();
      } catch (e) {
        expect((e as SvnError).kind).toBe('parse');
      }
    }
  });
});

const STATUS = `<?xml version="1.0"?>
<status><target path=".">
<entry path="a.txt"><wc-status item="modified" props="none" revision="3"><commit revision="2"><author>x</author></commit></wc-status></entry>
<entry path="new.txt"><wc-status item="unversioned" props="none"></wc-status></entry>
<entry path="locked.txt"><wc-status item="normal" props="none" wc-locked="true" revision="3"/></entry>
<entry path="remote.txt"><wc-status item="normal" props="none" revision="3"/><repos-status item="modified" props="none"/></entry>
<entry path="p"><wc-status item="normal" props="normal" revision="3"/><repos-status item="none" props="modified"/></entry>
<against revision="9"/>
</target></status>`;

describe('parseStatus', () => {
  const { entries, youngest } = parseStatus(STATUS);
  const by = (p: string) => entries.find((e) => e.path === p)!;
  it('reads youngest from <against>', () => expect(youngest).toBe(9));
  it('reads wc status', () => {
    expect(by('a.txt')).toMatchObject({ item: 'modified', props: 'none', revision: 3, wcLocked: false });
    expect(by('new.txt')).toMatchObject({ item: 'unversioned', revision: undefined });
    expect(by('locked.txt').wcLocked).toBe(true);
  });
  it('reads repoItem/repoProps with -u', () => {
    expect(by('remote.txt')).toMatchObject({ repoItem: 'modified', repoProps: 'none' });
    expect(by('p')).toMatchObject({ repoItem: 'none', repoProps: 'modified' });
    expect(by('a.txt').repoItem).toBeUndefined();
  });
  it('handles empty targets and single entries', () => {
    expect(parseStatus('<status><target path="."></target></status>')).toEqual({ entries: [], youngest: undefined });
    expect(parseStatus('<status><target path="."><entry path="z"><wc-status item="added" props="none"/></entry></target></status>').entries).toHaveLength(1);
  });
});

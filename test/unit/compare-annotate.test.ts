import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compactBlame, hunkAuthors, rowAuthorLabel, sideTitle } from '../../src/compare/annotate';
import { shouldAutoUpdate } from '../../src/compare/uptodate';
import { normalizeRequest } from '../../src/compare/sources';

const blame = [
  { line: 1, revision: 1, author: 'amy', date: '2024-01-01T00:00:00Z' },
  { line: 2, revision: 5, author: 'bob', date: '2024-02-02T00:00:00Z' },
  { line: 3, revision: 5, author: 'bob' },
  { line: 4, revision: 9, author: 'cy' },
  { line: 5, revision: 1, author: 'amy' },
];

describe('side titles', () => {
  it('shows the last committer and revision instead of the generic label', () => {
    expect(sideTitle('Server HEAD', { author: 'yusra', revision: 4031 })).toBe('yusra \u00b7 r4031');
    expect(sideTitle('BASE (last update)', { author: 'yusra', revision: 7 }, true)).toBe('BASE \u00b7 yusra \u00b7 r7');
  });
  it('falls back to the label when unknown, and to the revision when there is no author', () => {
    expect(sideTitle('Server HEAD', undefined)).toBe('Server HEAD');
    expect(sideTitle('Server HEAD', { revision: 3 })).toBe('r3');
  });
});

describe('hunk authors', () => {
  const b = compactBlame(blame, 5);
  it('compacts blame into a table plus per-line indexes', () => {
    expect(b?.table).toHaveLength(3);
    expect(b?.idx).toHaveLength(5);
    expect(compactBlame(blame, 3)).toBeUndefined();
  });
  it('lists the authors of a changed range in order with line counts', () => {
    if (!b) throw new Error('no blame');
    expect(hunkAuthors(b, 1, 4).authors).toEqual([{ author: 'bob', lines: 2 }, { author: 'cy', lines: 1 }]);
    expect(hunkAuthors(b, 4, 5).authors).toEqual([{ author: 'amy', lines: 1 }]);
  });
  it('labels the hunk start and only author changes inside a multi-author hunk', () => {
    if (!b) throw new Error('no blame');
    expect(rowAuthorLabel(b, 1, 4, 1)?.text).toBe('bob +1');
    expect(rowAuthorLabel(b, 1, 4, 1)?.title).toContain('cy: 1 line');
    expect(rowAuthorLabel(b, 1, 4, 2)).toBeUndefined();
    expect(rowAuthorLabel(b, 1, 4, 3)?.text).toBe('cy');
    expect(rowAuthorLabel(b, 4, 5, 4)?.text).toBe('amy');
    expect(rowAuthorLabel(b, 1, 4, 0)).toBeUndefined();
  });
});

describe('auto update when local equals incoming', () => {
  const base = { leftIsLocal: true, rightIsHead: true, leftText: 'x\n', docText: 'x\n', rightText: 'x\n', listedIncoming: true };
  it('updates only on exact equality of a listed incoming file', () => {
    expect(shouldAutoUpdate(base)).toBe(true);
    expect(shouldAutoUpdate({ ...base, docText: 'x\ny\n' })).toBe(false);
    expect(shouldAutoUpdate({ ...base, leftText: 'x\r\n', docText: 'x\r\n' })).toBe(false);
    expect(shouldAutoUpdate({ ...base, listedIncoming: false })).toBe(false);
    expect(shouldAutoUpdate({ ...base, rightIsHead: false })).toBe(false);
  });
});

describe('pane compare reuse and view wiring', () => {
  it('keeps the reuse key through normalization', () => {
    const l = { kind: 'local', fsPath: 'a' } as const;
    const r = { kind: 'rev', repoName: 'r', target: 'a', rev: 'HEAD' } as const;
    expect(normalizeRequest({ left: r, right: l, reuseKey: 'pane' }).reuseKey).toBe('pane');
  });
  const src = (f: string): string => fs.readFileSync(path.join(__dirname, '../../src/compare', f), 'utf8');
  it('pane clicks share one panel; Open in editor is not beside', () => {
    expect(src('commands.ts')).toMatch(/PANE_COMPARE_KEY/);
    expect(src('panel.ts')).not.toMatch(/ViewColumn\.Beside/);
  });
  it('shows no hidden-differences banner', () => {
    expect(src('webview/main.ts')).not.toMatch(/hiddenDifferenceBadge|ignored: they are hidden/);
  });
});

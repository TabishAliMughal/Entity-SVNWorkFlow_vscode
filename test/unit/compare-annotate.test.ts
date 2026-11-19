import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LABEL_TAIL, renderedLabel, type CompactBlame, compactBlame, formatLocalDate, hunkAuthors, sectionLabel, showsSectionLabel, sideTitle } from '../../src/compare/annotate';
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
  it('gives one label per section from its newest commit, "<committer> | YYYY-MM-DD HH:mm:ss" in local time', () => {
    if (!b) throw new Error('no blame');
    const d = new Date('2024-02-02T00:00:00Z');
    const p = (n: number) => String(n).padStart(2, '0');
    const local = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    // lines 0-2: amy r1, bob r5, bob r5 -> newest is bob r5
    expect(sectionLabel(b, 0, 3)).toBe(`bob | ${local}`);
    // lines 1-3 (bob r5, bob r5, cy r9 without date) -> newest is cy r9
    expect(sectionLabel(b, 1, 4)).toBe('cy');
    expect(sectionLabel(b, 4, 4)).toBeUndefined();
    expect(formatLocalDate('nope')).toBe('');
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

describe('section label selection', () => {
  it('skips outgoing-only sections (right side unchanged), keeps incoming, conflict, mixed and 2-way', () => {
    expect(showsSectionLabel('outgoing')).toBe(false);
    for (const c of ['incoming', 'conflict', 'mixed', undefined] as const) expect(showsSectionLabel(c)).toBe(true);
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

describe('rendered label text', () => {
  it('is exactly `name | YYYY-MM-DD HH:mm:ss` plus three U+00A0, no other junk', () => {
    const b = compactBlame([{ line: 1, revision: 3, author: 'faaiz', date: '2026-11-17T12:59:15Z' }], 1) as CompactBlame;
    const text = renderedLabel(sectionLabel(b, 0, 1) as string);
    expect(text.slice(-3)).toBe(LABEL_TAIL);
    expect(text.slice(0, -3)).toMatch(/^faaiz \| \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(text).not.toContain('00a0');
    expect(LABEL_TAIL).toBe(String.fromCharCode(160).repeat(3));
  });
  it('no source file contains a mangled escape', () => {
    for (const f of ['compare/annotate.ts', 'compare/webview/main.ts']) {
      expect(fs.readFileSync(path.join(__dirname, '../../src', f), 'utf8')).not.toMatch(/00a0/);
    }
  });
});

describe('compare webview scroll and label wiring', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/compare/webview/main.ts'), 'utf8');
  it('syncs horizontal scroll with a re-entrancy guard and keeps the label inline', () => {
    expect(main).toMatch(/setScrollLeft/);
    expect(main).toMatch(/syncingScroll/);
    expect(main).toMatch(/inlineClassName: 'cmp-au'/);
    expect(main).not.toMatch(/positionLabels|cmp-labels/);
  });
});

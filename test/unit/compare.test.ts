import { describe, expect, it } from 'vitest';
import { diffLines, applyHunk } from '../../src/diff';
import { decodeContent, hasNulBytes, isBinaryMime } from '../../src/compare/content';
import { buildRows, hunkRowStarts } from '../../src/compare/rows';
import { markWords, splitHighlighted } from '../../src/compare/lineHtml';
import { applyAllHunks, minimalEdit } from '../../src/compare/pull';
import { languageFor, monacoLanguageFor } from '../../src/compare/langs';
import { pickEditable, sourceName } from '../../src/compare/sources';

const b = (...n: number[]): Uint8Array => Uint8Array.from(n);

describe('decodeContent', () => {
  it('decodes plain UTF-8', () => {
    expect(decodeContent(Buffer.from('h\u00e9llo'))).toMatchObject({ text: 'h\u00e9llo', encoding: 'utf-8', binary: false });
  });
  it('strips the UTF-8 BOM', () => {
    const r = decodeContent(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('abc')]));
    expect(r).toMatchObject({ text: 'abc', encoding: 'utf-8-bom' });
  });
  it('falls back to windows-1252 for invalid UTF-8', () => {
    const r = decodeContent(b(0x63, 0x61, 0x66, 0xe9, 0x20, 0x80));
    expect(r.encoding).toBe('windows-1252');
    expect(r.text).toBe('caf\u00e9 \u20ac');
  });
  it('decodes UTF-16 with BOM as text', () => {
    const le = decodeContent(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi\n', 'utf16le')]));
    expect(le).toMatchObject({ text: 'hi\n', encoding: 'utf-16le', binary: false });
    const be = decodeContent(b(0xfe, 0xff, 0, 0x68, 0, 0x69));
    expect(be).toMatchObject({ text: 'hi', encoding: 'utf-16be' });
  });
  it('detects binary by NUL byte and by mime type', () => {
    expect(hasNulBytes(b(1, 2, 0, 3))).toBe(true);
    expect(decodeContent(b(0x89, 0x50, 0x4e, 0x47, 0, 0)).binary).toBe(true);
    expect(decodeContent(Buffer.from('plain'), 'application/octet-stream').binary).toBe(true);
    expect(decodeContent(Buffer.from('plain'), 'text/plain').binary).toBe(false);
    expect(isBinaryMime('application/json')).toBe(false);
    expect(isBinaryMime('image/png')).toBe(true);
    expect(isBinaryMime(undefined)).toBe(false);
  });
  it('handles empty content', () => {
    expect(decodeContent(Buffer.alloc(0))).toMatchObject({ text: '', binary: false });
  });
});

describe('buildRows', () => {
  it('aligns an insert between unchanged lines with left fillers', () => {
    const d = diffLines('a\nb\n', 'a\nx\ny\nb\n');
    const rows = buildRows(d.blocks);
    expect(rows.map((r) => [r.left, r.right, r.kind])).toEqual([
      [0, 0, 'equal'],
      [-1, 1, 'insert'],
      [-1, 2, 'insert'],
      [1, 3, 'equal'],
    ]);
    expect(rows[1].first).toBe(true);
    expect(rows[2].first).toBe(false);
    expect(hunkRowStarts(rows)).toEqual([1]);
  });
  it('pads the shorter side of a modify and numbers hunks', () => {
    const d = diffLines('a\nOLD1\nOLD2\nz\nq\n', 'a\nNEW1\nz\n');
    const rows = buildRows(d.blocks);
    const hunks = rows.filter((r) => r.hunk >= 0);
    expect(new Set(hunks.map((r) => r.hunk)).size).toBe(d.hunks.length);
    // every line of both files appears exactly once, in order
    expect(rows.filter((r) => r.left >= 0).map((r) => r.left)).toEqual([0, 1, 2, 3, 4]);
    expect(rows.filter((r) => r.right >= 0).map((r) => r.right)).toEqual([0, 1, 2]);
  });
  it('D13: new function above a renamed one gives separate hunks', () => {
    const local = ['<?php', 'class A {', '    function setDealerCreditLimit($id) {', '        return 1;', '    }', '}', ''].join('\n');
    const inc = ['<?php', 'class A {', '    private function setDealerBalanceData() {', '        $x = 1;', '        return $x;', '    }', '', '    function setDealerBalance($id) {', '        return 1;', '    }', '}', ''].join('\n');
    const d = diffLines(local, inc);
    expect(d.hunks.map((h) => h.type)).toEqual(['insert', 'modify']);
    const rows = buildRows(d.blocks);
    expect(rows.filter((r) => r.kind === 'insert').every((r) => r.left === -1)).toBe(true);
  });
});

describe('pull helpers', () => {
  it('minimalEdit finds the changed middle', () => {
    expect(minimalEdit('abcdef', 'abXYef')).toEqual({ start: 2, end: 4, text: 'XY' });
    expect(minimalEdit('abc', 'abc')).toBeUndefined();
    expect(minimalEdit('ab', 'abab')).toMatchObject({ text: expect.any(String) });
  });
  it('applyAllHunks equals the incoming text and matches repeated applyHunk', () => {
    const local = 'a\nb\nc\nd\ne\nf\n';
    const inc = 'a\nB\nc\nnew\nd\nf\ng\n';
    const d = diffLines(local, inc);
    expect(applyAllHunks(local, inc, d, 'local')).toBe(inc);
    let t = local;
    for (let i = 0; i < 10; i++) {
      const dd = diffLines(t, inc);
      if (!dd.hunks.length) break;
      t = applyHunk(t, inc, dd.hunks[0]);
    }
    expect(t).toBe(inc);
  });
  it('applyAllHunks into the right side (reverse direction)', () => {
    const left = 'a\nX\nc\n';
    const right = 'a\nb\nc\nd\n';
    const d = diffLines(left, right);
    expect(applyAllHunks(right, left, d, 'incoming')).toBe(left);
  });
  it('whitespace-only differences are untouched by pull all when ignored', () => {
    const local = 'a  \nb\n';
    const inc = 'a\nB\n';
    const d = diffLines(local, inc, { ignoreWhitespace: 'trailing' });
    expect(applyAllHunks(local, inc, d, 'local', { ignoreWhitespace: 'trailing' })).toBe('a  \nB\n');
  });
});

describe('lineHtml', () => {
  it('splits highlighted html across lines keeping spans balanced', () => {
    const lines = splitHighlighted('<span class="c">/* a\nb */</span>\nx');
    expect(lines).toEqual(['<span class="c">/* a</span>', '<span class="c">b */</span>', 'x']);
  });
  it('marks word ranges in plain text columns across spans and entities', () => {
    const html = '<span class="k">if</span> (a &lt; b)';
    const out = markWords(html, [{ start: 1, end: 6 }]);
    expect(out.replace(/<[^>]+>/g, '')).toBe('if (a &lt; b)');
    expect(out).toBe('<span class="k">i<mark class="w">f</mark></span><mark class="w"> (a </mark>&lt; b)');
  });
  it('counts an entity as one column', () => {
    expect(markWords('&lt;&lt;x', [{ start: 2, end: 3 }])).toBe('&lt;&lt;<mark class="w">x</mark>');
  });
});

describe('misc', () => {
  it('language lookup', () => {
    expect(languageFor('a.PHP')).toBe('php');
    expect(languageFor('x.html')).toBe('xml');
    expect(languageFor('Makefile')).toBeUndefined();
    expect(monacoLanguageFor('x.html')).toBe('html');
    expect(monacoLanguageFor('x.xml')).toBe('xml');
    expect(monacoLanguageFor('run.sh')).toBe('shell');
    expect(monacoLanguageFor('a.json')).toBe('json');
    expect(monacoLanguageFor('x.patch')).toBeUndefined();
    expect(monacoLanguageFor('Makefile')).toBeUndefined();
  });
  it('names sources and picks the editable side', () => {
    expect(sourceName({ kind: 'local', fsPath: 'C:\\wc\\src\\a.php' })).toBe('a.php');
    const l = { kind: 'local', fsPath: 'x' } as const;
    const r = { kind: 'rev', repoName: 'r', target: 'x', rev: 'HEAD' } as const;
    expect(pickEditable({ left: l, right: r })).toBe('left');
    expect(pickEditable({ left: r, right: l })).toBe('right');
    expect(pickEditable({ left: r, right: r })).toBeNull();
    expect(pickEditable({ left: l, right: l, editableSide: 'right' })).toBe('right');
  });
});

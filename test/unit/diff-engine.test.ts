import { describe, expect, it } from 'vitest';
import { applyHunk, applyHunkReverse, diffLines, matchSequences, wordDiffForHunk, type Hunk } from '../../src/diff';

const lines = (...l: string[]): string => l.map((x) => x + '\n').join('');

const PREV = ['<?php', 'class Dealer {', '    private function loadDealer($id){', '        return $this->db->find($id);', '    }', ''];
const NEWFN = [
  '    private function setDealerBalanceData(){',
  '        $rows = $this->db->query("SELECT * FROM balances");',
  '        $out = array();',
  '        foreach ($rows as $row) {',
  '            if ($row["active"]) {',
  '                $out[$row["dealer_id"]] = $row["amount"];',
  '            }',
  '        }',
  '        $this->cache->put("balances", $out);',
  '        $total = 0;',
  '        foreach ($out as $v) {',
  '            $total += $v;',
  '        }',
  '        $this->log("balance total " . $total);',
  '        $this->flag = true;',
  '        $this->touch();',
  '        $this->audit("balances");',
  '        $this->done = 1;',
  '        return $out;',
  '    }',
  '',
];
const OLDSIG = '    function setDealerCreditLimit($id){';
const NEWSIG = '    function setDealerBalance($id){';
const BODY = ['        $limit = $this->db->limit($id);', '        return $limit;', '    }', '}'];

const LOCAL = lines(...PREV, OLDSIG, ...BODY);
const INCOMING = lines(...PREV, ...NEWFN, NEWSIG, ...BODY);

describe('D13 acceptance scenario', () => {
  const r = diffLines(LOCAL, INCOMING);

  it('yields exactly one pure insert and one separate modify hunk', () => {
    expect(r.hunks.map((h) => h.type)).toEqual(['insert', 'modify']);
    const [ins, mod] = r.hunks;
    expect(ins).toMatchObject({ localStart: PREV.length, localEnd: PREV.length, incomingStart: PREV.length, incomingEnd: PREV.length + NEWFN.length });
    expect(mod).toMatchObject({ localStart: PREV.length, localEnd: PREV.length + 1, incomingStart: PREV.length + NEWFN.length, incomingEnd: PREV.length + NEWFN.length + 1 });
  });

  it('keeps surrounding lines equal and the insert includes the blank line', () => {
    expect(r.blocks.map((b) => b.type)).toEqual(['equal', 'insert', 'modify', 'equal']);
    expect(NEWFN[NEWFN.length - 1]).toBe('');
    const first = r.blocks[0];
    expect(first.localEnd).toBe(PREV.length);
  });

  it('highlights only the function name at word level', () => {
    const mod = r.hunks[1];
    const line = PREV.length;
    expect(mod.words!.local).toEqual([{ line, start: OLDSIG.indexOf('setDealerCreditLimit'), end: OLDSIG.indexOf('setDealerCreditLimit') + 'setDealerCreditLimit'.length }]);
    const iline = PREV.length + NEWFN.length;
    expect(mod.words!.incoming).toEqual([{ line: iline, start: NEWSIG.indexOf('setDealerBalance'), end: NEWSIG.indexOf('setDealerBalance') + 'setDealerBalance'.length }]);
  });

  it('pulling only the insert keeps the old name', () => {
    const out = applyHunk(LOCAL, INCOMING, r.hunks[0]);
    expect(out).toBe(lines(...PREV, ...NEWFN, OLDSIG, ...BODY));
    const again = diffLines(out, INCOMING);
    expect(again.hunks.map((h) => h.type)).toEqual(['modify']);
  });

  it('pulling only the modify keeps the file without the new function', () => {
    const out = applyHunk(LOCAL, INCOMING, r.hunks[1]);
    expect(out).toBe(lines(...PREV, NEWSIG, ...BODY));
    const again = diffLines(out, INCOMING);
    expect(again.hunks.map((h) => h.type)).toEqual(['insert']);
  });

  it('pulling both converges, in either order', () => {
    const a = applyHunk(applyHunk(LOCAL, INCOMING, r.hunks[0]), INCOMING, diffLines(applyHunk(LOCAL, INCOMING, r.hunks[0]), INCOMING).hunks[0]);
    expect(a).toBe(INCOMING);
  });

  it('works symmetrically (swap sides: delete + modify)', () => {
    const s = diffLines(INCOMING, LOCAL);
    expect(s.hunks.map((h) => h.type)).toEqual(['delete', 'modify']);
  });
});

describe('line anchoring', () => {
  it('does not mis-anchor on repeated braces and blank lines', () => {
    const a = lines('function a() {', '  x();', '}', '', 'function b() {', '  y();', '}', '');
    const b = lines('function a() {', '  x();', '}', '', 'function n() {', '  z();', '}', '', 'function b() {', '  y();', '}', '');
    const r = diffLines(a, b);
    expect(r.hunks).toHaveLength(1);
    expect(r.hunks[0].type).toBe('insert');
    expect(applyHunk(a, b, r.hunks[0])).toBe(b);
  });

  it('anchors on a unique line between repeated ones', () => {
    const a = lines('}', '}', 'UNIQUE', '}', '}');
    const b = lines('}', '}', 'extra1', 'extra2', 'UNIQUE', '}', '}');
    const r = diffLines(a, b);
    expect(r.hunks).toHaveLength(1);
    expect(r.hunks[0]).toMatchObject({ type: 'insert', incomingStart: 2, incomingEnd: 4 });
  });

  it('shows a moved block as a delete plus an insert', () => {
    const a = lines('h1', 'h2', 'h3', 'MOVE1', 'MOVE2', 'm1', 'm2', 'm3', 'e1', 'e2');
    const b = lines('h1', 'h2', 'h3', 'm1', 'm2', 'm3', 'MOVE1', 'MOVE2', 'e1', 'e2');
    const r = diffLines(a, b);
    expect(r.hunks.map((h) => h.type).sort()).toEqual(['delete', 'insert']);
    let cur = a;
    for (let i = 0; i < 2; i++) {
      const d = diffLines(cur, b);
      if (d.identical) break;
      cur = applyHunk(cur, b, d.hunks[0]);
    }
    expect(cur).toBe(b);
  });

  it('empty vs content and back', () => {
    const c = lines('a', 'b');
    const ins = diffLines('', c);
    expect(ins.hunks).toEqual([{ type: 'insert', localStart: 0, localEnd: 0, incomingStart: 0, incomingEnd: 2 }]);
    const del = diffLines(c, '');
    expect(del.hunks).toEqual([{ type: 'delete', localStart: 0, localEnd: 2, incomingStart: 0, incomingEnd: 0 }]);
    expect(diffLines('', '').identical).toBe(true);
    expect(applyHunk('', c, ins.hunks[0])).toBe(c);
    expect(applyHunk(c, '', del.hunks[0])).toBe('');
  });

  it('identical files give one equal block', () => {
    const r = diffLines(lines('a', 'b'), lines('a', 'b'));
    expect(r.identical).toBe(true);
    expect(r.blocks).toEqual([{ type: 'equal', localStart: 0, localEnd: 2, incomingStart: 0, incomingEnd: 2 }]);
  });

  it('adjacent changes stay one modify hunk when lines are dissimilar', () => {
    const r = diffLines(lines('a', 'x = 1;', 'b'), lines('a', 'y = 2;', 'q', 'b'));
    expect(r.hunks).toHaveLength(1);
    expect(r.hunks[0].type).toBe('modify');
  });

  it('splits a trailing-similar pair off a pure deletion', () => {
    const r = diffLines(lines('keep', 'old1()', 'old2()', 'call(alpha, beta)', 'end'), lines('keep', 'call(alpha, gamma)', 'end'));
    expect(r.hunks.map((h) => h.type)).toEqual(['delete', 'modify']);
  });
});

describe('normalisation options', () => {
  it('ignoreWhitespace none / trailing / all', () => {
    const a = 'x = 1;  \nfoo bar\n';
    const b = 'x = 1;\nfoobar\n';
    expect(diffLines(a, b).hunks).toHaveLength(1);
    const t = diffLines(a, b, { ignoreWhitespace: 'trailing' });
    expect(t.hunks).toHaveLength(1);
    expect(t.hunks[0]).toMatchObject({ localStart: 1, localEnd: 2 });
    expect(diffLines(a, b, { ignoreWhitespace: 'all' }).identical).toBe(true);
  });

  it('leading indentation matters unless all', () => {
    expect(diffLines('  a\n', 'a\n', { ignoreWhitespace: 'trailing' }).identical).toBe(false);
    expect(diffLines('  a\n', 'a\n', { ignoreWhitespace: 'all' }).identical).toBe(true);
  });

  it('CRLF vs LF', () => {
    const crlf = 'a\r\nb\r\nc\r\n';
    const lf = 'a\nb\nc\n';
    expect(diffLines(crlf, lf).hunks).toHaveLength(1);
    expect(diffLines(crlf, lf, { ignoreEol: true }).identical).toBe(true);
  });

  it('trailing newline at EOF', () => {
    expect(diffLines('a\nb', 'a\nb\n').hunks).toEqual([expect.objectContaining({ type: 'modify', localStart: 1, localEnd: 2 })]);
    expect(diffLines('a\nb', 'a\nb\n', { ignoreEol: true }).identical).toBe(true);
    const extra = diffLines('a\n', 'a\n\n', { ignoreEol: true });
    expect(extra.hunks).toEqual([{ type: 'insert', localStart: 1, localEnd: 1, incomingStart: 1, incomingEnd: 2 }]);
  });

  it('whitespace-only intra-line differences are not highlighted under all', () => {
    const r = diffLines('a  b c\n', 'a b d\n', { ignoreWhitespace: 'all' });
    expect(r.hunks[0].words!.local).toEqual([{ line: 0, start: 5, end: 6 }]);
  });
});

describe('ignoreCase', () => {
  it('case-only differences produce no hunks when ignored', () => {
    const a = lines('Hello World', 'FOO');
    const b = lines('hello world', 'foo');
    expect(diffLines(a, b).hunks).toHaveLength(1);
    expect(diffLines(a, b, { ignoreCase: true }).identical).toBe(true);
  });

  it('mixed case and content change only reports the content change', () => {
    const a = lines('Alpha', 'Beta', 'GAMMA');
    const b = lines('ALPHA', 'delta', 'gamma');
    const r = diffLines(a, b, { ignoreCase: true });
    expect(r.hunks).toHaveLength(1);
    expect(r.hunks[0]).toMatchObject({ type: 'modify', localStart: 1, localEnd: 2, incomingStart: 1, incomingEnd: 2 });
  });

  it('combines with ignoreWhitespace and ignoreEol', () => {
    const a = 'Foo  Bar  \r\nX\r\n';
    const b = 'foobar\nx';
    expect(diffLines(a, b, { ignoreCase: true }).identical).toBe(false);
    expect(diffLines(a, b, { ignoreCase: true, ignoreWhitespace: 'all' }).identical).toBe(false);
    expect(diffLines(a, b, { ignoreCase: true, ignoreWhitespace: 'all', ignoreEol: true }).identical).toBe(true);
    expect(diffLines('Foo  \n', 'foo\n', { ignoreCase: true, ignoreWhitespace: 'trailing' }).identical).toBe(true);
  });

  it('word-level tokens compare case-insensitively and applyHunk copies original text', () => {
    const a = 'Return FooBar(1);\n';
    const b = 'return foobar(2);\n';
    const r = diffLines(a, b, { ignoreCase: true });
    expect(r.hunks[0].words).toEqual({ local: [{ line: 0, start: 14, end: 15 }], incoming: [{ line: 0, start: 14, end: 15 }] });
    expect(applyHunk(a, b, r.hunks[0], { ignoreCase: true })).toBe(b);
  });

  it('pulling a content hunk leaves case-only lines untouched', () => {
    const a = lines('Keep', 'old');
    const b = lines('KEEP', 'new');
    const r = diffLines(a, b, { ignoreCase: true });
    expect(applyHunk(a, b, r.hunks[0], { ignoreCase: true })).toBe(lines('Keep', 'new'));
  });
});

describe('exact LCS', () => {
  const dpLen = (a: number[], b: number[]): number => {
    let prev = new Int32Array(b.length + 1);
    let cur = new Int32Array(b.length + 1);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) cur[j] = a[i] === b[j] ? prev[j + 1] + 1 : Math.max(prev[j], cur[j + 1]);
      [prev, cur] = [cur, prev];
    }
    return prev[0];
  };
  const rng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };

  it('matches the reference DP length on random inputs', () => {
    const r = rng(42);
    for (let t = 0; t < 300; t++) {
      const alpha = 1 + Math.floor(r() * 8);
      const a = Array.from({ length: Math.floor(r() * 60) }, () => Math.floor(r() * alpha));
      const b = Array.from({ length: Math.floor(r() * 60) }, () => Math.floor(r() * alpha));
      const ms = matchSequences(a, b);
      let total = 0;
      let pa = 0;
      let pb = 0;
      for (const m of ms) {
        expect(m.a).toBeGreaterThanOrEqual(pa);
        expect(m.b).toBeGreaterThanOrEqual(pb);
        for (let k = 0; k < m.len; k++) expect(a[m.a + k]).toBe(b[m.b + k]);
        pa = m.a + m.len;
        pb = m.b + m.len;
        total += m.len;
      }
      expect(total).toBe(dpLen(a, b));
    }
  });

  it('dense inputs (all lines frequent) are still optimal', () => {
    const r = rng(7);
    const a = Array.from({ length: 150 }, () => Math.floor(r() * 2));
    const b = Array.from({ length: 170 }, () => Math.floor(r() * 2));
    expect(matchSequences(a, b).reduce((s, m) => s + m.len, 0)).toBe(dpLen(a, b));
  });

  it('Hirschberg path (forced by dense regions) gives the optimal length', () => {
    const r = rng(11);
    const a = Array.from({ length: 5000 }, () => Math.floor(r() * 2));
    const b = Array.from({ length: 5000 }, () => Math.floor(r() * 2));
    const t = Date.now();
    const total = matchSequences(a, b).reduce((s, m) => s + m.len, 0);
    expect(Date.now() - t).toBeLessThan(8000);
    expect(total).toBe(dpLen(a, b));
  });

  it('tie-break: prefers matching a rare line over a frequent brace', () => {
    const r = diffLines(lines('}', 'U'), lines('U', '}', '}', '}'));
    expect(r.hunks.map((h) => h.type)).toEqual(['delete', 'insert']);
    expect(r.blocks.find((b) => b.type === 'equal')).toMatchObject({ localStart: 1, localEnd: 2, incomingStart: 0, incomingEnd: 1 });
  });

  it('dissimilar noisy files still converge through applyHunk', () => {
    const a = lines(...Array.from({ length: 300 }, (_, i) => `${i % 2 ? 'p' : 'q'}`));
    const b = lines(...Array.from({ length: 300 }, (_, i) => `${i % 3 ? 'p' : 'r'}`));
    let cur = a;
    for (let i = 0; i < 1000 && !diffLines(cur, b).identical; i++) cur = applyHunk(cur, b, diffLines(cur, b).hunks[0]);
    expect(cur).toBe(b);
  });
});

describe('determinism and performance', () => {
  const big = (n: number, mutate: boolean): string => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      if (mutate && i % 500 === 250) out.push(`inserted ${i}`);
      out.push(mutate && i % 700 === 3 ? `changed line ${i}` : i % 9 === 0 ? '}' : i % 13 === 0 ? '' : `line ${i} value`);
    }
    return lines(...out);
  };

  it('is deterministic', () => {
    const a = big(3000, false);
    const b = big(3000, true);
    expect(JSON.stringify(diffLines(a, b))).toBe(JSON.stringify(diffLines(a, b)));
  });

  it('diffs 20k-line files with scattered edits quickly', () => {
    const a = big(20000, false);
    const b = big(20000, true);
    const t = Date.now();
    const r = diffLines(a, b);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(r.hunks.length).toBeGreaterThan(40);
    let cur = a;
    for (const h of [...r.hunks].reverse()) cur = applyHunk(cur, b, h);
    expect(cur).toBe(b);
  });

  it('handles two completely different 10k-line files', () => {
    const a = lines(...Array.from({ length: 10000 }, (_, i) => `a${i}`));
    const b = lines(...Array.from({ length: 10000 }, (_, i) => `b${i}`));
    const t = Date.now();
    const r = diffLines(a, b);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(r.hunks).toHaveLength(1);
  });
});

describe('applyHunk', () => {
  const pairs: [string, string][] = [
    [lines('a', 'b', 'c', 'd', 'e'), lines('a', 'B', 'c', 'x', 'y', 'd')],
    [lines('a', 'b', 'c'), lines('c')],
    [lines('1', '2', '3', '4', '5', '6'), lines('1', '3', '4', '5', 'six')],
    ['a\nb', 'a\nb\nc'],
    ['a\nb\n', 'a\nb'],
  ];

  it('pulls hunks one at a time until identical (any order)', () => {
    for (const [a, b] of pairs) {
      for (const pickLast of [false, true]) {
        let cur = a;
        for (let i = 0; i < 50; i++) {
          const d = diffLines(cur, b);
          if (d.identical) break;
          const before = d.hunks.length;
          const h = pickLast ? d.hunks[d.hunks.length - 1] : d.hunks[0];
          cur = applyHunk(cur, b, h);
          expect(diffLines(cur, b).hunks.length).toBeLessThan(before + 1);
        }
        expect(cur).toBe(b);
      }
    }
  });

  it('a pulled hunk does not touch other hunks', () => {
    const a = lines('a', 'b', 'c', 'd', 'e', 'f', 'g');
    const b = lines('a', 'B', 'c', 'd', 'e', 'F', 'g');
    const r = diffLines(a, b);
    expect(r.hunks).toHaveLength(2);
    expect(applyHunk(a, b, r.hunks[0])).toBe(lines('a', 'B', 'c', 'd', 'e', 'f', 'g'));
    expect(applyHunk(a, b, r.hunks[1])).toBe(lines('a', 'b', 'c', 'd', 'e', 'F', 'g'));
  });

  it('reverse pushes local content into incoming', () => {
    const a = lines('a', 'b', 'c');
    const b = lines('a', 'x', 'c', 'd');
    const r = diffLines(a, b);
    let cur = b;
    for (const h of [...r.hunks].reverse()) cur = applyHunkReverse(a, cur, h);
    expect(cur).toBe(a);
  });

  it('preserves the local CRLF convention when EOLs are ignored', () => {
    const a = 'a\r\nb\r\nc\r\n';
    const b = 'a\nX\nb\nc\n';
    const r = diffLines(a, b, { ignoreEol: true });
    expect(applyHunk(a, b, r.hunks[0], { ignoreEol: true })).toBe('a\r\nX\r\nb\r\nc\r\n');
  });

  it('keeps the incoming EOL when EOLs are significant', () => {
    const a = 'a\r\nb\r\n';
    const b = 'a\r\nb\n';
    const r = diffLines(a, b);
    expect(applyHunk(a, b, r.hunks[0])).toBe(b);
  });

  it('adds a missing newline to a previously last line when appending', () => {
    expect(applyHunk('a', 'a\nb', diffLines('a', 'a\nb', { ignoreEol: true }).hunks[0], { ignoreEol: true })).toBe('a\nb');
  });

  it('rejects stale hunks', () => {
    const h: Hunk = { type: 'insert', localStart: 99, localEnd: 99, incomingStart: 0, incomingEnd: 1 };
    expect(() => applyHunk('a\n', 'b\n', h)).toThrow(RangeError);
  });
});

describe('word-level diff', () => {
  it('uses identifiers, numbers, whitespace and punctuation tokens', () => {
    const r = diffLines('x = foo(12, 3.5);\n', 'x = foo(13, 3.5);\n');
    expect(r.hunks[0].words).toEqual({ local: [{ line: 0, start: 8, end: 10 }], incoming: [{ line: 0, start: 8, end: 10 }] });
  });

  it('wordDiffForHunk matches the eager result', () => {
    const a = 'let alpha = 1;\n';
    const b = 'let beta = 1;\n';
    const r = diffLines(a, b);
    expect(wordDiffForHunk(a, b, r.hunks[0])).toEqual(r.hunks[0].words);
  });
});

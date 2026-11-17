import { describe, expect, it } from 'vitest';
import { applyHunk, diffLines, type DiffOptions } from '../../src/diff';
import { hiddenDifferenceBadge, hiddenDifferenceKinds } from '../../src/diff/hidden';

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
const CLEAN = lines(...PREV, ...NEWFN, NEWSIG, ...BODY);

/** The incoming side carries extra noise on lines that are otherwise unchanged. */
const NOISE: Record<string, (incoming: string) => string> = {
  trailing: (t) => t.replace('return $limit;', 'return $limit;   ').replace('<?php', '<?php\t'),
  all: (t) => t.replace('$limit = $this->db', '$limit=$this->db').replace('return $this->db', 'return  $this->db'),
  case: (t) => t.replace('return $limit;', 'RETURN $limit;').replace('class Dealer', 'CLASS dealer'),
  eol: (t) => t.replace(/\n/g, '\r\n'),
};

const OPTIONS: Array<{ name: string; opts: DiffOptions; noise: string[] }> = [
  { name: 'ignore trailing whitespace', opts: { ignoreWhitespace: 'trailing' }, noise: ['trailing'] },
  { name: 'ignore all whitespace', opts: { ignoreWhitespace: 'all' }, noise: ['trailing', 'all'] },
  { name: 'ignore case', opts: { ignoreCase: true }, noise: ['case'] },
  { name: 'ignore EOL', opts: { ignoreEol: true }, noise: ['eol'] },
  { name: 'all options together', opts: { ignoreWhitespace: 'all', ignoreCase: true, ignoreEol: true }, noise: ['trailing', 'all', 'case', 'eol'] },
];

const withNoise = (kinds: string[]): string => kinds.reduce((t, k) => NOISE[k](t), CLEAN);

describe('D13 acceptance scenario combined with each ignore option', () => {
  it('without options the noise shows up as extra hunks (so the options matter)', () => {
    for (const k of Object.keys(NOISE)) expect(diffLines(LOCAL, NOISE[k](CLEAN)).hunks.map((h) => h.type), k).not.toEqual(['insert', 'modify']);
  });

  for (const o of OPTIONS) {
    describe(o.name, () => {
      const incoming = withNoise(o.noise);
      const r = diffLines(LOCAL, incoming, o.opts);

      it('still yields one pure insert and one separate modify', () => {
        expect(r.hunks.map((h) => h.type)).toEqual(['insert', 'modify']);
        expect(r.hunks[0]).toMatchObject({ localStart: PREV.length, localEnd: PREV.length, incomingStart: PREV.length, incomingEnd: PREV.length + NEWFN.length });
        expect(r.hunks[1]).toMatchObject({ localStart: PREV.length, localEnd: PREV.length + 1, incomingStart: PREV.length + NEWFN.length, incomingEnd: PREV.length + NEWFN.length + 1 });
      });

      it('highlights only the renamed identifier', () => {
        const w = r.hunks[1].words;
        expect(w?.local).toHaveLength(1);
        expect(OLDSIG.slice(w!.local[0].start, w!.local[0].end)).toBe('setDealerCreditLimit');
      });

      it('pulling the insert keeps the old name and the hidden (ignored) parts of the local file', () => {
        const out = applyHunk(LOCAL, incoming, r.hunks[0], o.opts);
        const outLines = out.replace(/\r\n/g, '\n').split('\n');
        expect(outLines).toContain(OLDSIG);
        expect(outLines).not.toContain(NEWSIG);
        for (const l of BODY) expect(outLines).toContain(l);
        const again = diffLines(out, incoming, o.opts);
        expect(again.hunks.map((h) => h.type)).toEqual(['modify']);
      });

      it('pulling the modify leaves the new function out', () => {
        const out = applyHunk(LOCAL, incoming, r.hunks[1], o.opts);
        const outLines = out.replace(/\r\n/g, '\n').split('\n');
        expect(outLines.some((l) => l.trimEnd().toLowerCase() === NEWSIG.toLowerCase())).toBe(true);
        expect(outLines.some((l) => l.includes('setDealerBalanceData'))).toBe(false);
        expect(diffLines(out, incoming, o.opts).hunks.map((h) => h.type)).toEqual(['insert']);
      });

      it('pulling both ends with no remaining differences under the same options', () => {
        const a = applyHunk(LOCAL, incoming, r.hunks[0], o.opts);
        const b = applyHunk(a, incoming, diffLines(a, incoming, o.opts).hunks[0], o.opts);
        expect(diffLines(b, incoming, o.opts).hunks).toEqual([]);
      });
    });
  }
});

describe('hidden-difference badge (shared by the compare and merge views)', () => {
  it('lists the hidden kinds in a fixed order', () => {
    expect(hiddenDifferenceKinds({})).toEqual([]);
    expect(hiddenDifferenceKinds({ ignoreWhitespace: 'none', ignoreCase: false, ignoreEol: false })).toEqual([]);
    expect(hiddenDifferenceKinds({ ignoreWhitespace: 'trailing' })).toEqual(['whitespace']);
    expect(hiddenDifferenceKinds({ ignoreWhitespace: 'all', ignoreEol: true, ignoreCase: true })).toEqual(['whitespace', 'case', 'EOL']);
  });

  it('is empty without options and worded per view', () => {
    expect(hiddenDifferenceBadge({ ignoreWhitespace: 'none', ignoreEol: false, ignoreCase: false })).toBe('');
    expect(hiddenDifferenceBadge({ ignoreCase: true })).toBe('case differences ignored: they are hidden in this view');
    expect(hiddenDifferenceBadge({ ignoreEol: true, ignoreWhitespace: 'all' }, 'merge')).toBe('whitespace/EOL differences ignored: they are hidden in this merge');
  });
});

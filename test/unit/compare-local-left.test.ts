import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeRequest, pickEditable, type Source } from '../../src/compare/sources';

const local: Source = { kind: 'local', fsPath: 'C:/wc/a.txt' };
const rev: Source = { kind: 'rev', repoName: 'r', target: 'C:/wc/a.txt', rev: 'HEAD' };
const rev2: Source = { kind: 'rev', repoName: 'r', target: 'C:/wc/a.txt', rev: 5 };
const text: Source = { kind: 'text', text: '', name: 'a.txt' };

describe('local working copy is always the left, editable side', () => {
  it('swaps a local right side to the left', () => {
    const n = normalizeRequest({ left: rev, right: local, editableSide: 'right' });
    expect(n.left).toBe(local);
    expect(n.right).toBe(rev);
    expect(pickEditable(n)).toBe('left');
  });
  it('keeps an already correct request', () => {
    const n = normalizeRequest({ left: local, right: rev });
    expect(n).toMatchObject({ left: local, right: rev, editableSide: 'left' });
  });
  it('two local files: left stays left and is the editable one', () => {
    const other: Source = { kind: 'local', fsPath: 'C:/wc/b.txt' };
    const n = normalizeRequest({ left: local, right: other, editableSide: 'right' });
    expect(n).toMatchObject({ left: local, right: other, editableSide: 'left' });
  });
  it('views without a local side keep their order and stay read only', () => {
    for (const pair of [[rev2, rev], [text, text], [rev, text]] as const) {
      const n = normalizeRequest({ left: pair[0], right: pair[1] });
      expect(n.left).toBe(pair[0]);
      expect(n.right).toBe(pair[1]);
      expect(pickEditable(n)).toBeNull();
    }
  });
});

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
}

describe('source scan: no caller puts the local file on the right', () => {
  const files = sources(path.join(__dirname, '../../src')).filter((f) => !f.split(path.sep).join('/').endsWith('compare/sources.ts'));
  it('never builds a right-hand local source or an editable right side', () => {
    const bad: string[] = [];
    for (const f of files) {
      const s = fs.readFileSync(f, 'utf8');
      if (/right:\s*\{\s*kind:\s*'local'/.test(s) || /editableSide:\s*'right'/.test(s)) bad.push(path.relative(path.join(__dirname, '../..'), f));
    }
    expect(bad).toEqual([]);
  });
  it('has no swap option in the compare view', () => {
    const ui = fs.readFileSync(path.join(__dirname, '../../src/compare/webview/main.ts'), 'utf8') + fs.readFileSync(path.join(__dirname, '../../src/compare/protocol.ts'), 'utf8');
    expect(/swap/i.test(ui)).toBe(false);
  });
  it('every openCompare entry goes through normalizeRequest', () => {
    const panel = fs.readFileSync(path.join(__dirname, '../../src/compare/panel.ts'), 'utf8');
    expect(panel).toMatch(/const req = normalizeRequest\(request\)/);
  });
});

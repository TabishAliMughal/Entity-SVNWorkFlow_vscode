import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffLines } from '../../src/diff';
import { classifyHunks, rangesOverlap } from '../../src/compare/classify';

const L = (...l: string[]): string => l.join('\n') + '\n';
const classes = (base: string, local: string, incoming: string): string[] => classifyHunks(base, local, incoming, diffLines(local, incoming).hunks);

const BASE = L('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h');

describe('rangesOverlap', () => {
  it('treats touching ranges as not overlapping', () => {
    expect(rangesOverlap(0, 2, 2, 4)).toBe(false);
    expect(rangesOverlap(0, 3, 2, 4)).toBe(true);
  });
  it('handles empty insertion points', () => {
    expect(rangesOverlap(2, 2, 2, 2)).toBe(true);
    expect(rangesOverlap(2, 2, 0, 2)).toBe(false);
    expect(rangesOverlap(2, 2, 1, 3)).toBe(true);
  });
});

describe('classifyHunks (BASE as common ancestor)', () => {
  it('server-only change is incoming', () => {
    expect(classes(BASE, BASE, L('a', 'B', 'c', 'd', 'e', 'f', 'g', 'h'))).toEqual(['incoming']);
  });
  it('local-only change is outgoing', () => {
    expect(classes(BASE, L('a', 'b', 'c', 'D', 'e', 'f', 'g', 'h'), BASE)).toEqual(['outgoing']);
  });
  it('both changing the same line differently is a conflict', () => {
    expect(classes(BASE, L('a', 'X', 'c', 'd', 'e', 'f', 'g', 'h'), L('a', 'Y', 'c', 'd', 'e', 'f', 'g', 'h'))).toEqual(['conflict']);
  });
  it('separate regions are classified separately', () => {
    const local = L('a', 'b', 'c', 'D', 'e', 'f', 'g', 'h');
    const incoming = L('a', 'B', 'c', 'd', 'e', 'f', 'g', 'H');
    expect(classes(BASE, local, incoming)).toEqual(['incoming', 'outgoing', 'incoming']);
  });
  it('the same change on both sides produces no hunk, so no conflict', () => {
    const both = L('a', 'Z', 'c', 'd', 'e', 'f', 'g', 'h');
    expect(classes(BASE, both, both)).toEqual([]);
    const local = L('a', 'Z', 'c', 'd', 'e', 'f', 'g', 'h');
    const incoming = L('a', 'Z', 'c', 'd', 'e', 'f', 'g', 'H');
    expect(classes(BASE, local, incoming)).toEqual(['incoming']);
  });
  it('adjacent but non-overlapping changes are not a conflict', () => {
    const local = L('a', 'X', 'c', 'd', 'e', 'f', 'g', 'h');
    const incoming = L('a', 'b', 'Y', 'd', 'e', 'f', 'g', 'h');
    const r = classes(BASE, local, incoming);
    expect(r).not.toContain('conflict');
    expect(r.length).toBeGreaterThan(0);
  });
  it('a delete on one side against an edit on the other is a conflict', () => {
    expect(classes(BASE, L('a', 'c', 'd', 'e', 'f', 'g', 'h'), L('a', 'B', 'c', 'd', 'e', 'f', 'g', 'h'))).toEqual(['conflict']);
  });
  it('a server delete of untouched lines is incoming; a local insertion is outgoing', () => {
    expect(classes(BASE, BASE, L('a', 'b', 'e', 'f', 'g', 'h'))).toEqual(['incoming']);
    expect(classes(BASE, L('a', 'b', 'NEW', 'c', 'd', 'e', 'f', 'g', 'h'), BASE)).toEqual(['outgoing']);
  });
  it('both inserting at the same place with different text is a conflict', () => {
    expect(classes(BASE, L('a', 'b', 'X', 'c', 'd', 'e', 'f', 'g', 'h'), L('a', 'b', 'Y', 'c', 'd', 'e', 'f', 'g', 'h'))).toEqual(['conflict']);
  });
});

describe('class colours', () => {
  const read = (f: string): string => readFileSync(join(__dirname, '../..', f), 'utf8');
  it('incoming-only is the default blue with a "Safe to pull" tooltip; outgoing and mixed are grey', () => {
    const css = read('media/compare/compare.css');
    expect(read('src/compare/webview/main.ts')).toContain("incoming: 'Safe to pull'");
    expect(css).not.toMatch(/.conn.k-in path/);
    expect(css).toMatch(/.conn.k-out path, .conn.k-mx path/);
  });
});

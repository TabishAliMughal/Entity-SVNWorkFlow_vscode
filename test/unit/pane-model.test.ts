import { describe, expect, it } from 'vitest';
import { buildLabel, contextValueFor, folderContextValue, filterItems, matchesFilter, parseFilter, relativeDescription, statusIcon, statusText } from '../../src/pane/model';

const out = { outgoing: true, incoming: false };
const inc = { outgoing: false, incoming: true };
const both = { outgoing: true, incoming: true };

describe('pane filters', () => {
  it('outgoing / incoming / all (union)', () => {
    const items = [out, inc, both];
    expect(filterItems(items, 'outgoing')).toEqual([out, both]);
    expect(filterItems(items, 'incoming')).toEqual([inc, both]);
    expect(filterItems(items, 'all')).toHaveLength(3);
    expect(matchesFilter({ outgoing: false, incoming: false }, 'all')).toBe(false);
  });
  it('parses persisted values defensively', () => {
    expect(parseFilter('incoming')).toBe('incoming');
    expect(parseFilter('bogus')).toBe('all');
    expect(parseFilter(undefined)).toBe('all');
  });
});

describe('labels', () => {
  it('builds <filename> (<committer>)', () => {
    expect(buildLabel('a.txt', 'alice')).toBe('a.txt (alice)');
    expect(buildLabel('a.txt', undefined)).toBe('a.txt');
  });
  it('relative path with forward slashes', () => {
    const root = process.platform === 'win32' ? 'C:\\wc' : '/wc';
    const file = process.platform === 'win32' ? 'C:\\wc\\src\\a.txt' : '/wc/src/a.txt';
    expect(relativeDescription(file, root)).toBe('src/a.txt');
  });
  it('status text and icons', () => {
    expect(statusText({ item: 'modified', props: 'none', repoItem: 'modified', repoProps: 'none', ...both })).toBe('Local: modified | Incoming: modified');
    expect(statusIcon({ item: 'unversioned', ...out }).id).toBe('question');
    expect(statusIcon({ item: 'normal', ...inc }).id).toBe('cloud-download');
  });
  it('context value carries flags', () => {
    const v = contextValueFor({ item: 'modified', ...both }, false);
    expect(v).toMatch(/\bsvnItem\b/);
    expect(v).toMatch(/\bincoming\b/);
    expect(v).toMatch(/\bfile\b/);
    expect(contextValueFor({ item: 'unversioned', ...out }, true)).not.toMatch(/\bincoming\b/);
  });
});

describe('folderContextValue', () => {
  it('flags outgoing, incoming and an all-unversioned folder', () => {
    expect(folderContextValue([{ item: 'modified', outgoing: true, incoming: false }, { item: 'normal', outgoing: false, incoming: true }])).toBe('svnFolder outgoing incoming');
    expect(folderContextValue([{ item: 'unversioned', outgoing: true, incoming: false }])).toBe('svnFolder outgoing unversioned');
    expect(folderContextValue([])).toBe('svnFolder');
  });
});

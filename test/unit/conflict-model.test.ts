import { describe, expect, it } from 'vitest';
import { encodeText } from '../../src/conflict/encode';
import {
  conflictArtifacts,
  conflictFlags,
  conflictKinds,
  conflictedItems,
  describeTreeConflict,
  expandToConflicted,
  parseConflictInfo,
  parsePrejProps,
  summarizeConflicts,
  treeAdvice,
  versionUrl,
} from '../../src/conflict/model';
import { decodeContent } from '../../src/compare/content';

const INFO = `<?xml version="1.0" encoding="UTF-8"?>
<info>
<entry revision="282" kind="file" path="F:\\w\\cf.txt">
<url>svn://h/alpha/trunk/cf.txt</url>
<wc-info><schedule>normal</schedule></wc-info>
<conflict operation="update" type="text">
<version revision="280" side="source-left" kind="file" path-in-repos="trunk/cf.txt" repos-url="svn://h/alpha"/>
<version path-in-repos="trunk/cf.txt" repos-url="svn://h/alpha" revision="282" side="source-right" kind="file"/>
<prev-base-file>F:/w/cf.txt.r280</prev-base-file>
<prev-wc-file>F:/w/cf.txt.mine</prev-wc-file>
<cur-base-file>F:/w/cf.txt.r282</cur-base-file>
</conflict>
</entry>
<entry revision="282" kind="file" path="F:\\w\\te.txt">
<url>svn://h/alpha/trunk/te.txt</url>
<wc-info><schedule>delete</schedule></wc-info>
<tree-conflict reason="delete" victim="te.txt" action="edit" operation="update" kind="file">
<version path-in-repos="trunk/te.txt" repos-url="svn://h/alpha" revision="280" side="source-left" kind="file"/>
<version revision="282" side="source-right" kind="file" path-in-repos="trunk/te.txt" repos-url="svn://h/alpha"/>
</tree-conflict>
</entry>
<entry revision="282" kind="file" path="F:\\w\\both.txt">
<url>svn://h/alpha/trunk/both.txt</url>
<conflict operation="update" type="text"><prev-base-file>b</prev-base-file><prev-wc-file>m</prev-wc-file><cur-base-file>t</cur-base-file></conflict>
<conflict operation="update" type="property"><prop-file>F:/w/both.txt.prej</prop-file></conflict>
</entry>
<entry revision="282" kind="file" path="F:\\w\\clean.txt"><url>svn://h/alpha/trunk/clean.txt</url></entry>
</info>`;

describe('parseConflictInfo', () => {
  const [text, tree, both] = parseConflictInfo(INFO);
  it('reads text conflict files and versions', () => {
    expect(parseConflictInfo(INFO)).toHaveLength(3);
    expect(text.text).toEqual({ operation: 'update', baseFile: 'F:/w/cf.txt.r280', mineFile: 'F:/w/cf.txt.mine', theirsFile: 'F:/w/cf.txt.r282' });
    expect(text.left).toMatchObject({ revision: 280, pathInRepos: 'trunk/cf.txt' });
    expect(text.right?.revision).toBe(282);
  });
  it('reads tree conflicts', () => {
    expect(tree.tree).toEqual({ reason: 'delete', action: 'edit', operation: 'update', kind: 'file' });
    expect(tree.schedule).toBe('delete');
  });
  it('reads text and property conflicts on one entry', () => {
    expect(both.text?.mineFile).toBe('m');
    expect(both.property?.prejFile).toBe('F:/w/both.txt.prej');
  });
  it('builds a pegged url', () => {
    expect(versionUrl(text.left!)).toBe('svn://h/alpha/trunk/cf.txt@280');
    expect(versionUrl({ side: 'source-left', reposUrl: 'svn://h/r/', pathInRepos: 'a b/c#d', revision: 3 })).toBe('svn://h/r/a%20b/c%23d@3');
  });
});

describe('conflict kinds and lists', () => {
  const t = { item: 'conflicted', props: 'none' };
  const p = { item: 'normal', props: 'conflicted' };
  const tr = { item: 'deleted', props: 'none', treeConflicted: true };
  it('classifies', () => {
    expect(conflictKinds(t)).toEqual(['text']);
    expect(conflictKinds(p)).toEqual(['property']);
    expect(conflictKinds(tr)).toEqual(['tree']);
    expect(conflictKinds({ item: 'conflicted', props: 'conflicted', treeConflicted: true })).toEqual(['text', 'property', 'tree']);
    expect(conflictKinds({ item: 'modified', props: 'modified' })).toEqual([]);
  });
  it('flags for menus', () => {
    expect(conflictFlags(t)).toEqual(['conflicted', 'conflictText']);
    expect(conflictFlags(p)).toEqual(['conflicted', 'conflictProp']);
    expect(conflictFlags(tr)).toEqual(['conflicted', 'conflictTree']);
    expect(conflictFlags({ item: 'modified', props: 'none' })).toEqual([]);
  });
  it('summarizes', () => {
    expect(summarizeConflicts([t, p, tr, { item: 'modified', props: 'none' }])).toEqual({ total: 3, text: 1, property: 1, tree: 1 });
    expect(conflictedItems([t, { item: 'normal', props: 'none' }])).toEqual([t]);
  });
  it('expands folder and repo targets to the conflicted paths below them', () => {
    const c = ['C:\\wc\\a\\x.txt', 'C:\\wc\\a\\b\\y.txt', 'C:\\wc\\z.txt'];
    expect(expandToConflicted(['C:\\wc\\a'], c).sort()).toEqual(['C:\\wc\\a\\b\\y.txt', 'C:\\wc\\a\\x.txt']);
    expect(expandToConflicted(['C:\\wc\\z.txt'], c)).toEqual(['C:\\wc\\z.txt']);
    expect(expandToConflicted(['C:\\wc'], c)).toHaveLength(3);
    expect(expandToConflicted(['C:\\other'], c)).toEqual([]);
  });
  it('hides svn conflict artifacts only next to a conflicted item', () => {
    const items = [
      { path: 'C:\\wc\\cf.txt', item: 'conflicted', props: 'none' },
      { path: 'C:\\wc\\cf.txt.mine', item: 'unversioned', props: 'none' },
      { path: 'C:\\wc\\cf.txt.r280', item: 'unversioned', props: 'none' },
      { path: 'C:\\wc\\cf.txt.r282', item: 'unversioned', props: 'none' },
      { path: 'C:\\wc\\pc.txt', item: 'normal', props: 'conflicted' },
      { path: 'C:\\wc\\pc.txt.prej', item: 'unversioned', props: 'none' },
      { path: 'C:\\wc\\other.txt.mine', item: 'unversioned', props: 'none' },
      { path: 'C:\\wc\\d', item: 'normal', props: 'conflicted' },
      { path: 'C:\\wc\\d\\dir_conflicts.prej', item: 'unversioned', props: 'none' },
    ];
    expect([...conflictArtifacts(items)].map((i) => i.path).sort()).toEqual(['C:\\wc\\cf.txt.mine', 'C:\\wc\\cf.txt.r280', 'C:\\wc\\cf.txt.r282', 'C:\\wc\\d\\dir_conflicts.prej', 'C:\\wc\\pc.txt.prej']);
  });
});

describe('parsePrejProps', () => {
  it('finds property names', () => {
    const prej = "Trying to change property 'k'\nbut the property has already been locally changed to a different value.\nTrying to add new property 'svn:eol-style'\nbut the property already exists.\nTrying to delete property 'x y'\n";
    expect(parsePrejProps(prej)).toEqual(['k', 'svn:eol-style', 'x y']);
    expect(parsePrejProps('nothing')).toEqual([]);
  });
});

describe('tree conflict advice', () => {
  const ids = (t: Parameters<typeof treeAdvice>[0]) => treeAdvice(t).options.map((o) => o.id);
  const t = (reason: string, action: string, kind = 'file') => ({ reason, action, operation: 'update', kind });
  it('describes like svn', () => {
    expect(describeTreeConflict(t('delete', 'edit'))).toBe('Local file delete, incoming file edit upon update');
    expect(describeTreeConflict(t('edit', 'delete', 'dir'))).toBe('Local dir edit, incoming dir delete or move upon update');
    expect(describeTreeConflict({ ...t('missing', 'edit'), operation: 'merge' })).toBe('Local file missing, incoming file edit upon merge');
  });
  it('local edit / incoming delete', () => {
    const a = treeAdvice(t('edit', 'delete'));
    expect(ids(t('edit', 'delete'))).toEqual(['keep-local', 'accept-delete', 'follow-move', 'working']);
    expect(a.options[0].steps).toEqual([{ op: 'resolve', accept: 'working' }]);
    expect(a.options[1].destructive).toBe(true);
    expect(a.options[2].experimental).toBe(true);
  });
  it('local delete / incoming edit', () => {
    expect(ids(t('delete', 'edit'))).toEqual(['keep-delete', 'accept-incoming', 'working']);
    expect(treeAdvice(t('delete', 'edit')).options[1].steps).toEqual([{ op: 'revert' }]);
  });
  it('missing, add/add, obstruction, moved, delete/delete and unknown kinds', () => {
    expect(ids(t('missing', 'edit'))).toEqual(['restore', 'keep-missing', 'working']);
    expect(ids(t('add', 'add'))).toEqual(['keep-local-add', 'take-incoming-add', 'working']);
    expect(ids(t('obstruction', 'add'))).toEqual(['working']);
    expect(treeAdvice(t('obstruction', 'add')).guidance.join(' ')).toMatch(/unversioned/);
    expect(ids(t('moved-away', 'edit'))).toEqual(['move-target', 'break-move', 'working']);
    expect(ids(t('delete', 'delete'))).toEqual(['working']);
    expect(ids(t('weird', 'other'))).toEqual(['working']);
    // every kind offers a way to just mark it resolved
    for (const [r, a] of [['edit', 'delete'], ['delete', 'edit'], ['missing', 'edit'], ['add', 'add'], ['moved-away', 'edit']]) expect(ids(t(r, a))).toContain('working');
  });
  it('only uses accept values svn 1.14 allows for tree conflicts', () => {
    const allowed = new Set(['working', 'mine-conflict', 'theirs-conflict']);
    for (const [r, a] of [['edit', 'delete'], ['delete', 'edit'], ['missing', 'edit'], ['add', 'add'], ['moved-away', 'edit'], ['moved-here', 'delete']]) {
      for (const o of treeAdvice(t(r, a)).options) for (const s of o.steps) if (s.op === 'resolve') expect(allowed.has(s.accept)).toBe(true);
    }
  });
});

describe('encodeText', () => {
  it('round trips every encoding decodeContent can return', () => {
    const text = 'héllo\nwörld ✓\n';
    for (const enc of ['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be'] as const) {
      const { bytes, encoding } = encodeText(text, enc);
      expect(encoding).toBe(enc);
      expect(decodeContent(bytes)).toMatchObject({ text, encoding: enc });
    }
  });
  it('writes windows-1252 when possible and falls back to UTF-8 otherwise', () => {
    const ok = encodeText('café\n', 'windows-1252');
    expect(ok.encoding).toBe('windows-1252');
    expect([...ok.bytes]).toContain(0xe9);
    const lossy = encodeText('café ✓\n', 'windows-1252');
    expect(lossy.encoding).toBe('utf-8');
    expect(decodeContent(lossy.bytes).text).toBe('café ✓\n');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { WcDbWatcher } from '../../src/incoming/wcdb';
import { RepoLocks } from '../../src/override/commitLocks';
import { IncomingService, StatusSource } from '../../src/incoming/service';
import { AuthorResolver, newestAuthorFor, repoPathOf } from '../../src/incoming/authors';
import { SvnError } from '../../src/svn/errors';
import { parseLog } from '../../src/svn/xml';
import type { RepoEntry } from '../../src/repos/model';

const win = process.platform === 'win32';
const repo: RepoEntry = { name: 'r1', serverUrl: 'svn://x/r1/trunk', localFolder: win ? 'C:\\wc1' : '/wc1' };
const p = (rel: string): string => (win ? `C:\\wc1\\${rel.replace(/\//g, '\\')}` : `/wc1/${rel}`);

function fakeClient(script: Array<() => unknown>): StatusSource & { calls: boolean[] } {
  const calls: boolean[] = [];
  return {
    calls,
    async status(_t, opts) {
      calls.push(!!opts.showUpdates);
      const r = script.shift()?.();
      if (r instanceof Error) throw r;
      return r as { entries: never[] };
    },
  };
}
const st = (path: string, item: string, repoItem?: string) => ({ path, item, props: 'none', wcLocked: false, repoItem, revision: 1 });

describe('IncomingService', () => {
  it('aggregates incoming through folders and answers per path', async () => {
    const c = fakeClient([() => ({ entries: [st(p('src/util/a.txt'), 'normal', 'modified'), st(p('mine.txt'), 'modified')], youngest: 5 })]);
    const s = new IncomingService(c, () => [repo]);
    await s.refresh();
    expect(s.hasIncoming(p('src/util/a.txt'))).toBe(true);
    expect(s.hasIncoming(p('src'))).toBe(true);
    expect(s.hasIncoming(repo.localFolder)).toBe(true);
    expect(s.hasIncoming(p('mine.txt'))).toBe(false);
    expect(s.hasIncoming(p('other'))).toBe(false);
    expect(s.aggregatedIncomingPaths()).toHaveLength(4);
    expect(s.getState('r1')?.youngest).toBe(5);
  });

  it('local-only refresh keeps remembered incoming state', async () => {
    const c = fakeClient([() => ({ entries: [st(p('a.txt'), 'normal', 'modified')] }), () => ({ entries: [st(p('b.txt'), 'modified')] })]);
    const s = new IncomingService(c, () => [repo]);
    await s.refresh({ remote: true });
    await s.refresh({ remote: false });
    expect(c.calls).toEqual([true, false]);
    expect(s.hasIncoming(p('a.txt'))).toBe(true);
    expect(s.allItems().some((i) => i.outgoing && i.path === p('b.txt'))).toBe(true);
  });

  it('reports a persistent error once, keeps last good data, and recovers on manual refresh', async () => {
    const auth = () => new SvnError('auth', 'bad creds');
    const c = fakeClient([() => ({ entries: [st(p('a.txt'), 'normal', 'modified')] }), auth, auth, () => ({ entries: [] })]);
    const s = new IncomingService(c, () => [repo]);
    const errors: unknown[] = [];
    s.onDidError((_r, e) => errors.push(e));
    await s.refresh();
    await s.refresh();
    await s.refresh();
    expect(errors).toHaveLength(1);
    expect(s.getState('r1')?.error?.kind).toBe('auth');
    expect(s.hasIncoming(p('a.txt'))).toBe(true);
    await s.refresh({ manual: true });
    expect(s.getState('r1')?.error).toBeUndefined();
    expect(s.allItems()).toHaveLength(0);
  });

  it('holds back poll/auto refreshes while the repo is busy and runs one after release', async () => {
    const c = fakeClient([() => ({ entries: [st(p('a.txt'), 'modified')] })]);
    const locks = new RepoLocks();
    const s = new IncomingService(c, () => [repo]);
    s.isRepoBusy = (n) => locks.isBusy(n);
    locks.onRelease((n) => s.repoReleased(n));
    const release = locks.tryAcquire('r1');
    await s.refresh({ remote: true });
    expect(c.calls).toEqual([]);
    vi.useFakeTimers();
    try {
      release?.();
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
    }
    expect(c.calls).toEqual([true]);
  });

  it('a manual refresh ignores the busy state', async () => {
    const c = fakeClient([() => ({ entries: [] })]);
    const s = new IncomingService(c, () => [repo]);
    s.isRepoBusy = () => true;
    await s.refresh({ manual: true });
    expect(c.calls).toEqual([true]);
  });

  it('drops state for removed repos', async () => {
    let list = [repo];
    const c = fakeClient([() => ({ entries: [st(p('a.txt'), 'modified')] })]);
    const s = new IncomingService(c, () => list);
    await s.refresh();
    list = [];
    await s.refresh();
    expect(s.allStates()).toEqual([]);
  });
});

const LOG = `<?xml version="1.0"?><log>
<logentry revision="3"><author>carol</author><date>d</date><paths><path action="M" kind="file">/trunk/src/b.txt</path></paths><msg>m3</msg></logentry>
<logentry revision="2"><author>bob</author><date>d</date><paths><path action="M" kind="file">/trunk/src/a.txt</path><path action="D" kind="dir">/trunk/old</path></paths><msg>m2</msg></logentry>
</log>`;

describe('author lookup', () => {
  it('parses log and picks the newest author per path', () => {
    const log = parseLog(LOG);
    expect(log[0].paths[0]).toMatchObject({ action: 'M', path: '/trunk/src/b.txt' });
    expect(newestAuthorFor('/trunk/src/a.txt', log)).toBe('bob');
    expect(newestAuthorFor('/trunk/src/b.txt', log)).toBe('carol');
    expect(newestAuthorFor('/trunk/old/x.txt', log)).toBe('bob');
    expect(newestAuthorFor('/trunk/none.txt', log)).toBeUndefined();
  });
  it('maps local paths to repo paths', () => {
    expect(repoPathOf(p('src/a b.txt'), repo.localFolder, 'svn://x/r1/trunk', 'svn://x/r1')).toBe('/trunk/src/a b.txt');
  });
  it('batches: one log for incoming, one info for base, cached afterwards', async () => {
    const calls: string[] = [];
    const client = {
      async info() {
        return { url: 'svn://x/r1/trunk', repositoryRoot: 'svn://x/r1', revision: 1 } as never;
      },
      async run(args: readonly string[]) {
        calls.push(args[0]);
        if (args[0] === 'log') return { text: LOG };
        return { text: `<info><entry path="${p('m.txt')}" revision="1" kind="file"><url>svn://x/r1/trunk/m.txt</url><commit revision="1"><author>dave</author></commit></entry></info>` };
      },
    };
    const ar = new AuthorResolver(client);
    const base = { repoName: 'r1', props: 'none', revision: 1, outgoing: true, incoming: false };
    const items = [
      { ...base, path: p('src/a.txt'), item: 'normal', incoming: true, outgoing: false },
      { ...base, path: p('m.txt'), item: 'modified' },
      { ...base, path: p('new.txt'), item: 'unversioned', revision: undefined },
    ];
    expect(await ar.lookup(repo, items, 3)).toBe(true);
    expect(ar.get(items[0], 3)).toBe('bob');
    expect(ar.get(items[1], 3)).toBe('dave');
    expect(ar.get(items[2], 3)).toBeUndefined();
    expect(calls.sort()).toEqual(['info', 'log']);
    expect(await ar.lookup(repo, items, 3)).toBe(false);
  });
});

describe('WcDbWatcher', () => {
  const make = (own: () => boolean, mt: { v: number | undefined }) => {
    const changed = vi.fn();
    const w = new WcDbWatcher({ folder: 'x', debounceMs: 100, isOwnActivity: own, onExternalChange: changed, mtime: () => mt.v });
    return { w, changed };
  };

  it('reports an external change once, debounced', () => {
    vi.useFakeTimers();
    try {
      const mt = { v: 1 as number | undefined };
      const { w, changed } = make(() => false, mt);
      mt.v = 2;
      w.notify();
      w.notify();
      mt.v = 3;
      w.notify();
      vi.advanceTimersByTime(99);
      expect(changed).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2);
      expect(changed).toHaveBeenCalledTimes(1);
      w.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores unchanged mtimes and our own activity', () => {
    vi.useFakeTimers();
    try {
      const mt = { v: 1 as number | undefined };
      let own = true;
      const { w, changed } = make(() => own, mt);
      w.notify();
      mt.v = 2;
      w.notify();
      vi.advanceTimersByTime(500);
      expect(changed).not.toHaveBeenCalled();
      own = false;
      w.notify();
      vi.advanceTimersByTime(500);
      expect(changed).not.toHaveBeenCalled();
      mt.v = 3;
      w.notify();
      own = true;
      vi.advanceTimersByTime(500);
      expect(changed).not.toHaveBeenCalled();
      w.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

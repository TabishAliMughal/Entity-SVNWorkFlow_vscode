import { LockInfo } from '../svn/xml';

export type LockState = 'none' | 'mine' | 'other' | 'stale';

export interface LockView {
  state: LockState;
  info?: LockInfo;
}

/**
 * Combines the working-copy lock token (`local`) with the server lock (`remote`, only known after a `status -u`).
 * mine: we hold the token and the server agrees; stale: we hold a token the server no longer honours
 * (broken or stolen); other: someone else holds it. Without remote info a local token counts as mine.
 */
export function lockView(local: LockInfo | undefined, remote: LockInfo | undefined, remoteKnown: boolean): LockView {
  if (local?.token) {
    if (!remoteKnown) return { state: 'mine', info: local };
    if (!remote) return { state: 'stale', info: local };
    if (remote.token && remote.token !== local.token) return { state: 'other', info: remote };
    return { state: 'mine', info: remote };
  }
  if (remote) return { state: 'other', info: remote };
  return { state: 'none' };
}

export function describeLock(v: LockView): string {
  const i = v.info;
  const when = i?.created ? new Date(i.created).toLocaleString() : undefined;
  const by = i?.owner ? ` by ${i.owner}` : '';
  switch (v.state) {
    case 'mine':
      return `Locked${by} (you)${when ? ` on ${when}` : ''}${i?.comment ? `: ${i.comment}` : ''}`;
    case 'other':
      return `Locked${by}${when ? ` on ${when}` : ''}${i?.comment ? `: ${i.comment}` : ''}`;
    case 'stale':
      return 'Your lock was broken or stolen on the server (stale lock token)';
    default:
      return 'Not locked';
  }
}

/** Short badge for file decorations. */
export function lockBadge(v: LockView): string | undefined {
  return v.state === 'mine' ? 'L' : v.state === 'other' ? 'L!' : v.state === 'stale' ? 'L?' : undefined;
}

/** svn lists the lock owner "tester" etc.; compare case-sensitively as the server does. */
export function isNeedsLockProp(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

/** A needs-lock file is read-only on disk until locked; true when a write would be refused. */
export function needsLockPrompt(o: { needsLock: boolean; readOnly: boolean; state: LockState }): boolean {
  return o.needsLock && o.readOnly && o.state !== 'mine';
}

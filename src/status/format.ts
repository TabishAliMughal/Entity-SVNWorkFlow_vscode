import { ChangeItem } from '../incoming/model';

export interface StatusBarInput {
  busy: boolean;
  /** Repo of the active file, or undefined to show totals. */
  repoName?: string;
  incoming: number;
  outgoing: number;
  /** Number of repos whose last check failed. */
  failing: number;
}

export function countItems(items: readonly Pick<ChangeItem, 'incoming' | 'outgoing'>[]): { incoming: number; outgoing: number } {
  return { incoming: items.filter((i) => i.incoming).length, outgoing: items.filter((i) => i.outgoing).length };
}

export function statusBarText(s: StatusBarInput): string {
  const icon = s.busy ? '$(sync~spin)' : s.failing ? '$(warning)' : '$(source-control)';
  return `${icon} ${s.repoName ?? 'SVN'} $(arrow-down)${s.incoming} $(arrow-up)${s.outgoing}`;
}

export function statusBarTooltip(s: StatusBarInput, busyLabel: string): string {
  const lines = [s.repoName ? `SVN repository: ${s.repoName}` : 'SVN: all repositories', `${s.incoming} incoming, ${s.outgoing} outgoing`];
  if (busyLabel) lines.push(`Running: ${busyLabel}`);
  if (s.failing) lines.push(`${s.failing} repo(s) could not be checked (offline or authentication); showing last known state`);
  lines.push('Click for options');
  return lines.join('\n');
}

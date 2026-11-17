import type { IgnoreWhitespace } from './types';

export interface IgnoreOptions {
  ignoreWhitespace?: IgnoreWhitespace;
  ignoreEol?: boolean;
  ignoreCase?: boolean;
}

/** Which kinds of differences the active ignore options hide, in a fixed order. */
export function hiddenDifferenceKinds(o: IgnoreOptions): string[] {
  const kinds: string[] = [];
  if (o.ignoreWhitespace && o.ignoreWhitespace !== 'none') kinds.push('whitespace');
  if (o.ignoreCase) kinds.push('case');
  if (o.ignoreEol) kinds.push('EOL');
  return kinds;
}

/** The warning badge text of a diff view ("in this view") or merge view ("in this merge"); empty when nothing is hidden. */
export function hiddenDifferenceBadge(o: IgnoreOptions, where: 'view' | 'merge' = 'view'): string {
  const kinds = hiddenDifferenceKinds(o);
  return kinds.length ? `${kinds.join('/')} differences ignored: they are hidden in this ${where}` : '';
}

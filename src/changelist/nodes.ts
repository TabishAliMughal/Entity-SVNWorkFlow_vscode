import { ChangeItem } from '../incoming/model';
import { RepoEntry } from '../repos/model';

/** A pane group: a changelist, or the default "Changes" group (changelist undefined). */
export class ChangelistNode {
  constructor(readonly repo: RepoEntry, readonly title: string, readonly changelist: string | undefined, readonly items: ChangeItem[]) {}
}

export function isChangelistNode(x: unknown): x is ChangelistNode {
  return x instanceof ChangelistNode;
}

import { ChangelistNode } from '../changelist/nodes';
import { ChangeItem } from '../incoming/model';
import { RepoEntry } from '../repos/model';
import type { TreeEntry } from './tree';

export class RepoNode {
  constructor(readonly repo: RepoEntry) {}
}

export class ItemNode {
  /** `local`: shown inside the Local Ignore List group (restricted context menu). */
  constructor(readonly repo: RepoEntry, readonly item: ChangeItem, readonly local = false) {}
}

/** The "Local Ignore List" group: files that are never committed or updated by this extension. */
export class LocalIgnoreNode {
  constructor(readonly repo: RepoEntry, readonly items: ChangeItem[]) {}
}

export class MessageNode {
  constructor(readonly text: string, readonly icon?: string, readonly tooltip?: string) {}
}

/** The "Conflicts" group at the top of a repo (svn conflict list). */
export class ConflictsNode {
  constructor(readonly repo: RepoEntry, readonly items: ChangeItem[]) {}
}

/** A folder level in tree view; `items` are all changes at or below it. */
export class FolderNode {
  constructor(readonly repo: RepoEntry, readonly name: string, readonly path: string, readonly items: ChangeItem[], readonly children: TreeEntry[]) {}
}

export type PaneNode = RepoNode | ItemNode | MessageNode | ChangelistNode | ConflictsNode | FolderNode | LocalIgnoreNode;

export function isItemNode(x: unknown): x is ItemNode {
  return x instanceof ItemNode;
}

export function isRepoNode(x: unknown): x is RepoNode {
  return x instanceof RepoNode;
}


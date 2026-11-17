/* eslint-disable @typescript-eslint/no-explicit-any */
import { XMLParser } from 'fast-xml-parser';
import { SvnError } from './errors';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => ['entry', 'logentry', 'path', 'target'].includes(name),
});

export function parseXml(xml: string): any {
  try {
    return parser.parse(xml);
  } catch (e) {
    throw new SvnError('parse', `Could not parse svn XML output: ${(e as Error).message}`);
  }
}

export interface SvnInfo {
  path: string;
  url: string;
  repositoryRoot: string;
  repositoryUuid: string;
  revision: number;
  nodeKind: string;
  lastChangedRevision?: number;
  lastChangedAuthor?: string;
  lastChangedDate?: string;
}

function toInfo(e: any): SvnInfo {
  if (!e?.url) throw new SvnError('parse', 'Unexpected svn info output');
  return {
    path: e['@_path'],
    url: e.url,
    repositoryRoot: e.repository?.root ?? '',
    repositoryUuid: e.repository?.uuid ?? '',
    revision: Number(e['@_revision']),
    nodeKind: e['@_kind'],
    lastChangedRevision: e.commit ? Number(e.commit['@_revision']) : undefined,
    lastChangedAuthor: e.commit?.author,
    lastChangedDate: e.commit?.date,
  };
}

export function parseInfo(xml: string): SvnInfo {
  return toInfo(parseXml(xml)?.info?.entry?.[0]);
}

/** `svn info` with several targets: one entry per target. */
export function parseInfoAll(xml: string): SvnInfo[] {
  return ((parseXml(xml)?.info?.entry ?? []) as any[]).filter((e) => e?.url).map(toInfo);
}

export interface LogPath {
  action: string;
  kind?: string;
  /** Repository-root relative, unescaped, e.g. /trunk/src/a.txt */
  path: string;
  copyfromPath?: string;
  copyfromRev?: number;
}

export interface LogEntry {
  revision: number;
  author?: string;
  date?: string;
  message?: string;
  /** Only with --verbose. */
  paths: LogPath[];
}

export function parseLog(xml: string): LogEntry[] {
  const doc = parseXml(xml);
  return ((doc?.log?.logentry ?? []) as any[]).map((le) => ({
    revision: Number(le['@_revision']),
    author: typeof le.author === 'string' ? le.author : undefined,
    date: le.date,
    message: typeof le.msg === 'string' ? le.msg : undefined,
    paths: ((le.paths?.path ?? []) as any[]).map((p) => ({
      action: typeof p === 'string' ? '' : p['@_action'],
      kind: typeof p === 'string' ? undefined : p['@_kind'],
      path: typeof p === 'string' ? p : String(p['#text'] ?? ''),
      copyfromPath: typeof p === 'string' ? undefined : p['@_copyfrom-path'],
      copyfromRev: typeof p === 'string' || p['@_copyfrom-rev'] === undefined ? undefined : Number(p['@_copyfrom-rev']),
    })),
  }));
}

export interface BlameLine {
  /** 1-based. */
  line: number;
  revision?: number;
  author?: string;
  date?: string;
}

/** `svn blame --xml`: one entry per line; lines without a commit element (rare) keep only the line number. */
export function parseBlame(xml: string): BlameLine[] {
  const doc = parseXml(xml);
  const entries = ((doc?.blame?.target?.[0]?.entry ?? []) as any[]).map((e) => ({
    line: Number(e['@_line-number']),
    revision: e.commit?.['@_revision'] !== undefined ? Number(e.commit['@_revision']) : undefined,
    author: typeof e.commit?.author === 'string' ? e.commit.author : undefined,
    date: typeof e.commit?.date === 'string' ? e.commit.date : undefined,
  }));
  return entries.sort((a, b) => a.line - b.line);
}

export interface LockInfo {
  token?: string;
  owner?: string;
  comment?: string;
  /** ISO date. */
  created?: string;
}

function toLock(l: any): LockInfo | undefined {
  if (!l || typeof l !== 'object') return undefined;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return { token: str(l.token), owner: str(l.owner), comment: str(l.comment), created: str(l.created) };
}

export function parseLockElement(l: unknown): LockInfo | undefined {
  return toLock(l);
}

export interface StatusEntry {
  path: string;
  /** Working-copy item status, e.g. modified, added, unversioned, conflicted. */
  item: string;
  props: string;
  wcLocked: boolean;
  /** Added with history (svn copy / move destination, or a child of one). */
  copied?: boolean;
  movedFrom?: string;
  movedTo?: string;
  treeConflicted?: boolean;
  revision?: number;
  /** Server side, only with --show-updates. */
  repoItem?: string;
  repoProps?: string;
  /** Changelist name (svn changelist). */
  changelist?: string;
  /** Lock held by this working copy (has a token). */
  lock?: LockInfo;
  /** Lock on the server (with --show-updates). */
  repoLock?: LockInfo;
}

export function parseStatus(xml: string): { entries: StatusEntry[]; youngest?: number } {
  const doc = parseXml(xml);
  const entries: StatusEntry[] = [];
  let youngest: number | undefined;
  const addEntry = (en: any, changelist?: string): void => {
    const ws = en['wc-status'] ?? {};
    const rs = en['repos-status'];
    entries.push({
      path: en['@_path'],
      item: ws['@_item'],
      props: ws['@_props'],
      wcLocked: ws['@_wc-locked'] === 'true',
      copied: ws['@_copied'] === 'true' || undefined,
      movedFrom: ws['@_moved-from'],
      movedTo: ws['@_moved-to'],
      treeConflicted: ws['@_tree-conflicted'] === 'true' || undefined,
      revision: ws['@_revision'] !== undefined ? Number(ws['@_revision']) : undefined,
      repoItem: rs?.['@_item'],
      repoProps: rs?.['@_props'],
      changelist,
      lock: toLock(ws.lock),
      repoLock: toLock(rs?.lock),
    });
  };
  for (const t of (doc?.status?.target ?? []) as any[]) {
    if (t.against?.['@_revision']) youngest = Number(t.against['@_revision']);
    for (const en of (t.entry ?? []) as any[]) addEntry(en);
  }
  // Entries that belong to a changelist are listed in <changelist name="..."> siblings of <target>.
  const lists = doc?.status?.changelist;
  for (const cl of (Array.isArray(lists) ? lists : lists ? [lists] : []) as any[]) {
    const ens = cl.entry === undefined ? [] : Array.isArray(cl.entry) ? cl.entry : [cl.entry];
    for (const en of ens) addEntry(en, cl['@_name']);
  }
  return { entries, youngest };
}

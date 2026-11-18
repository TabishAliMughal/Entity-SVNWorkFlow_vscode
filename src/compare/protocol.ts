import type { DiffBlock, Hunk, IgnoreWhitespace } from '../diff';
import type { Pos } from './editing';
import type { CompactBlame, SideMeta } from './annotate';
import type { HunkClass } from './classify';

export interface SideInfo {
  name: string;
  label: string;
  /** highlight.js language id. */
  lang?: string;
  /** Present only when the text changed since the last message of this panel. */
  lines?: string[];
  lineCount: number;
  missing: boolean;
  encoding: string;
  /** Click-to-open is possible for this side. */
  openable: boolean;
  /** Text ends with a line break (or is empty): the document has one more, empty, last line. */
  endsWithEol: boolean;
  /** Last commit of a revision source, for the header. */
  meta?: SideMeta;
  /** Revision source labelled BASE. */
  isBase: boolean;
  /** Unsaved changes in the editor document. */
  dirty: boolean;
}

export interface DataMessage {
  type: 'data';
  /** Bumped for every diff; pulls carry it so a stale click is rejected. */
  version: number;
  /** Replaces the diff view with a notice (binary file, error). */
  notice?: string;
  left: SideInfo;
  right: SideInfo;
  blocks: DiffBlock[];
  hunks: Hunk[];
  /** Per hunk, via BASE as common ancestor; absent when there is no BASE to compare with (neutral styling). */
  classes?: HunkClass[];
  identical: boolean;
  /** Which side accepts pulls (the arrows point towards it); null = read only. */
  editable: 'left' | 'right' | null;
  options: { ignoreWhitespace: IgnoreWhitespace; ignoreEol: boolean; ignoreCase: boolean };
  canPickRevision: boolean;
  /** The editable side accepts typing (a local file that exists). */
  typing: boolean;
  /** Shown instead of the generic "identical" text after the file was brought up to date. */
  upToDate?: string;
  /** Last edit/undo/redo sequence number processed; the view ignores data older than what it sent. */
  ackSeq: number;
  /** Caret to set (after undo/redo). */
  caret?: Pos;
  busy?: boolean;
}

export type ToWebview = DataMessage | { type: 'busy'; busy: boolean } | { type: 'blame'; side: 'left' | 'right'; blame: CompactBlame };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'pull'; version: number; hunk: number }
  | { type: 'pullAll'; version: number }
  | { type: 'options'; ignoreWhitespace: IgnoreWhitespace; ignoreEol: boolean; ignoreCase: boolean }
  | { type: 'openAt'; side: 'left' | 'right'; line: number }
  | { type: 'edit'; seq: number; start: Pos; end: Pos; text: string }
  | { type: 'undo'; seq: number }
  | { type: 'redo'; seq: number }
  | { type: 'save' }
  | { type: 'pickRevision' }
  | { type: 'refresh' };

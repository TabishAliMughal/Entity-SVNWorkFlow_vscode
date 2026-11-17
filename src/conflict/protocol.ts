import type { IgnoreWhitespace } from '../diff';
import type { Choice, Segment } from './merge';

export interface SideData {
  label: string;
  /** Only when the text changed since the last message of this panel. */
  lines?: string[];
  lineCount: number;
}

export interface ConflictData {
  type: 'data';
  version: number;
  /** `property`: the three sides are the values of one property. */
  mode: 'text' | 'property';
  name: string;
  /** highlight.js language id. */
  lang?: string;
  /** .prej text, or other explanation shown above the merge. */
  notes?: string;
  encoding: string;
  mine: SideData;
  theirs: SideData;
  base: SideData;
  segments: Segment[];
  /** Per conflict index. */
  choices: Array<Choice | undefined>;
  /** Hand-edited text per conflict index (only for `custom` choices). */
  customs: Record<number, string>;
  unresolved: number;
  options: { ignoreWhitespace: IgnoreWhitespace; ignoreEol: boolean; ignoreCase: boolean };
  /** Result written to disk (or applied) and, for text, marked resolved. */
  saved: boolean;
  resolved: boolean;
  /** Shown on the primary buttons. */
  applyLabel: string;
  resolveLabel: string;
}

export type ToWebview = ConflictData | { type: 'busy'; busy: boolean } | { type: 'notice'; text: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'choose'; version: number; conflict: number; choice: Choice }
  | { type: 'edit'; version: number; conflict: number }
  | { type: 'custom'; version: number; conflict: number; text: string }
  | { type: 'chooseAll'; version: number; choice: 'mine' | 'theirs' }
  | { type: 'save'; version: number }
  | { type: 'saveResolve'; version: number }
  | { type: 'options'; ignoreWhitespace: IgnoreWhitespace; ignoreEol: boolean; ignoreCase: boolean }
  | { type: 'openFile' }
  | { type: 'refresh' };

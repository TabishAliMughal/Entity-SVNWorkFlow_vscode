export type IgnoreWhitespace = 'none' | 'trailing' | 'all';

export interface DiffOptions {
  /** none: exact; trailing: ignore trailing blanks; all: ignore every whitespace char. Default none. */
  ignoreWhitespace?: IgnoreWhitespace;
  /** Treat CRLF / LF / CR (and a missing final newline) as equal. Default false. */
  ignoreEol?: boolean;
  /** Compare case-insensitively (toLowerCase fold). Default false. */
  ignoreCase?: boolean;
}

export type HunkType = 'insert' | 'delete' | 'modify';

/** Character range inside one line (end exclusive, EOL not included). `line` is an absolute 0-based line index. */
export interface WordRange {
  line: number;
  start: number;
  end: number;
}

export interface WordDiff {
  local: WordRange[];
  incoming: WordRange[];
}

/** Line ranges are 0-based, end exclusive. insert: local range empty; delete: incoming range empty. */
export interface Hunk {
  type: HunkType;
  localStart: number;
  localEnd: number;
  incomingStart: number;
  incomingEnd: number;
  /** Only on modify hunks (omitted for very large hunks; use wordDiffForHunk). */
  words?: WordDiff;
}

export interface EqualRun {
  type: 'equal';
  localStart: number;
  localEnd: number;
  incomingStart: number;
  incomingEnd: number;
}

export type DiffBlock = Hunk | EqualRun;

export interface DiffResult {
  /** Full alignment in order: equal runs and hunks, covering both files. */
  blocks: DiffBlock[];
  hunks: Hunk[];
  localLineCount: number;
  incomingLineCount: number;
  identical: boolean;
}

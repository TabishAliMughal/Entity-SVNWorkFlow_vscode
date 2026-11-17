export { diffLines, diffParsed, wordDiffForHunk, SIMILARITY_THRESHOLD, WORD_DIFF_MAX_LINES } from './engine';
export { applyHunk, applyHunkReverse } from './apply';
export { matchSequences, MAX_SPARSE_POINTS, type Match } from './lcs';
export { tokenize, lineSimilarity, wordDiff, type Token } from './words';
export { splitLines, joinLines, type Line } from './text';
export type {
  DiffBlock,
  DiffOptions,
  DiffResult,
  EqualRun,
  Hunk,
  HunkType,
  IgnoreWhitespace,
  WordDiff,
  WordRange,
} from './types';

/** Pure helpers for `svn export`. */
import { pegSafe } from '../svn/client';

export type EolStyle = 'default' | 'LF' | 'CRLF' | 'CR';
export type ExportDepth = 'infinity' | 'immediates' | 'files' | 'empty';

export const EXPORT_DEPTHS: Array<{ label: string; description: string; depth: ExportDepth }> = [
  { label: 'Everything inside', description: 'recursive (default)', depth: 'infinity' },
  { label: 'Immediate children', description: 'files and sub-folders, but not their contents', depth: 'immediates' },
  { label: 'Files only', description: 'files directly in the folder', depth: 'files' },
  { label: 'Folder only', description: 'just the empty folder', depth: 'empty' },
];

export interface ExportOptions {
  /** Local path or URL. */
  source: string;
  dest: string;
  /** Revision; undefined = HEAD for a URL, the working files for a local path. */
  rev?: number | 'HEAD';
  depth: ExportDepth;
  eol: EolStyle;
  ignoreExternals: boolean;
  force: boolean;
}

export function buildExportArgs(o: ExportOptions): string[] {
  const args = ['export'];
  if (o.rev !== undefined) args.push('-r', String(o.rev));
  if (o.depth !== 'infinity') args.push('--depth', o.depth);
  if (o.eol !== 'default') args.push('--native-eol', o.eol);
  if (o.ignoreExternals) args.push('--ignore-externals');
  if (o.force) args.push('--force');
  // svn export reads a peg revision on both arguments, so a local path with '@' needs a trailing '@'
  args.push('--', pegSafe(o.source), pegSafe(o.dest));
  return args;
}

/** "Exported revision 12." -> 12 */
export function parseExportedRevision(text: string): number | undefined {
  const m = /Exported revision (\d+)/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

/** Number of exported items: svn prints `A    path` per item. */
export function countExported(text: string): number {
  return text.split(/\r?\n/).filter((l) => /^A\s+\S/.test(l)).length;
}

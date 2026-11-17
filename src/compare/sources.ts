import type { Rev } from './fetch';

/** One side of a compare view. */
export type Source =
  /** A working-copy file; text comes from the open editor document, so unsaved edits show and the side can be edited. */
  | { kind: 'local'; fsPath: string; repoName?: string; label?: string }
  /** `svn cat` of a local path or URL at a revision (HEAD, BASE or a number). Read only. */
  | { kind: 'rev'; repoName: string; target: string; rev: Rev; label?: string }
  /** Raw text (patch preview, conflict base ...). Read only. */
  | { kind: 'text'; text: string; name: string; label?: string };

export interface CompareRequest {
  left: Source;
  right: Source;
  /** Side that receives pulled hunks; must be a `local` source. Default: left if local, else right. */
  editableSide?: 'left' | 'right';
  /** Panel title. */
  title?: string;
  /** Requests with the same key share one panel: opening another replaces its content. */
  reuseKey?: string;
}

export function sourceName(s: Source): string {
  if (s.kind === 'text') return s.name;
  const t = s.kind === 'local' ? s.fsPath : s.target;
  return t.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? t;
}

export function revLabel(rev: Rev): string {
  return rev === 'HEAD' ? 'Server HEAD' : rev === 'BASE' ? 'BASE (last update)' : `Revision ${rev}`;
}

/** Rule: a local working file is always the left, editable side; the other source goes right. Views without a local side keep their order. */
export function normalizeRequest(req: CompareRequest): CompareRequest {
  const l = req.left.kind === 'local';
  const r = req.right.kind === 'local';
  if (r && !l) return { ...req, left: req.right, right: req.left, editableSide: 'left' };
  if (l) return { ...req, editableSide: 'left' };
  return req;
}

export function pickEditable(req: CompareRequest): 'left' | 'right' | null {
  const want = req.editableSide;
  if (want && req[want].kind === 'local') return want;
  if (req.left.kind === 'local') return 'left';
  if (req.right.kind === 'local') return 'right';
  return null;
}

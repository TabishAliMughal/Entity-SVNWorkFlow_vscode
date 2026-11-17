export type BulkKind = 'update' | 'commit';

export interface BulkConfirm {
  message: string;
  detail: string;
  /** Label of the confirm button. */
  action: string;
}

/** Text of the confirmation shown before updating or committing a whole working copy / all changes. */
export function bulkConfirmText(kind: BulkKind, repoName: string, folder: string, count: number): BulkConfirm {
  const n = `${count} ${kind === 'update' ? 'incoming' : 'outgoing'} item${count === 1 ? '' : 's'}`;
  return kind === 'update'
    ? { message: `Update all of "${repoName}"?`, detail: `Repository: ${repoName}\nFolder: ${folder}\nAffects: ${n} (the whole folder is updated to HEAD).`, action: 'Update' }
    : { message: `Commit all changes of "${repoName}"?`, detail: `Repository: ${repoName}\nFolder: ${folder}\nAffects: ${n}.`, action: 'Commit' };
}

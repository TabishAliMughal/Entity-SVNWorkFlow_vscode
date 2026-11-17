import * as vscode from 'vscode';
import type { Services } from '../services';

let lastOperationToast = 0;

/** True when an update/merge command showed its own conflict message a moment ago (the watcher then stays quiet). */
export function operationToastedRecently(withinMs = 8000): boolean {
  return Date.now() - lastOperationToast < withinMs;
}

/**
 * Warning for an operation that left conflicts (update, override-and-update, merge): same text as before plus
 * a button into the conflict list. Marks the time so the generic "new conflicts" watcher does not repeat it.
 */
export async function notifyConflicts(services: Services, message: string): Promise<void> {
  lastOperationToast = Date.now();
  services.logger.warn(message);
  const pick = await vscode.window.showWarningMessage(`SVN: ${message}`, 'Resolve Conflicts', 'Show Output');
  if (pick === 'Resolve Conflicts') await vscode.commands.executeCommand('svnWorkflow.conflict.list');
  else if (pick === 'Show Output') services.output.show(true);
}

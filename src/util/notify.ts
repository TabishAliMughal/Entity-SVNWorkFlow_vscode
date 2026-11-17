import * as vscode from 'vscode';
import { Services } from '../services';
import { activity } from '../status/activity';
import { SvnError } from '../svn/errors';

/** Result notifications: one style everywhere. Failures go through reportError. */
export function notifySuccess(services: Services, message: string): void {
  services.logger.info(message);
  void vscode.window.showInformationMessage(`SVN: ${message}`);
}

export async function notifyWarning(services: Services, message: string): Promise<void> {
  services.logger.warn(message);
  const pick = await vscode.window.showWarningMessage(`SVN: ${message}`, 'Show Output');
  if (pick) services.output.show(true);
}

/** Cancellable progress notification that also drives the status bar spinner. Cancel aborts the running svn process. */
export function runOperation<T>(title: string, fn: (signal: AbortSignal, step: (message: string) => void) => Promise<T>): Promise<T> {
  return activity.track(title, () =>
    Promise.resolve(
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `SVN: ${title}`, cancellable: true }, (progress, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        return fn(ac.signal, (message) => progress.report({ message }));
      }),
    ),
  );
}

export function isCancelled(e: unknown): boolean {
  return e instanceof SvnError && e.kind === 'cancelled';
}

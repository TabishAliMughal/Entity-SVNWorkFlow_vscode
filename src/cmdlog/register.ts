import * as vscode from 'vscode';
import { CONFIG_SECTION, type Services } from '../services';
import { reportError } from '../util/ui';
import { CommandHistory, Verbosity, commandLine, formatRecord, parseVerbosity } from './model';

export function registerCommandLog(context: vscode.ExtensionContext, services: Services): void {
  const channel = vscode.window.createOutputChannel('SVN Commands');
  const history = new CommandHistory();
  context.subscriptions.push(channel);
  const verbosity = (): Verbosity => parseVerbosity(vscode.workspace.getConfiguration(CONFIG_SECTION).get('commandLog.verbosity', 'commands'));

  services.client.setCommandObserver((rec) => {
    const v = verbosity();
    if (v === 'off') return;
    history.add(rec);
    channel.appendLine(formatRecord(rec, v));
  });
  context.subscriptions.push({ dispose: () => services.client.setCommandObserver(undefined) });

  const reg = (id: string, fn: () => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        try {
          await fn();
        } catch (e) {
          await reportError(services, e);
        }
      }),
    );
  };

  reg('svnWorkflow.cmdlog.show', async () => {
    channel.show(true);
    if (verbosity() === 'off') {
      const pick = await vscode.window.showInformationMessage('SVN command logging is off.', 'Log Commands', 'Open Settings');
      if (pick === 'Log Commands') await vscode.workspace.getConfiguration(CONFIG_SECTION).update('commandLog.verbosity', 'commands', vscode.ConfigurationTarget.Global);
      else if (pick === 'Open Settings') await vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG_SECTION}.commandLog.verbosity`);
    }
  });

  reg('svnWorkflow.cmdlog.copy', async () => {
    const items = history.list().map((r) => ({
      label: commandLine(r),
      description: `exit ${r.exitCode}  ${r.durationMs} ms`,
      detail: `${new Date(r.time).toLocaleTimeString()}${r.repoName ? `  ${r.repoName}` : ''}${r.cwd ? `  ${r.cwd}` : ''}`,
    }));
    if (!items.length) {
      void vscode.window.showInformationMessage('SVN: no commands logged yet (see svnWorkflow.commandLog.verbosity).');
      return;
    }
    const pick = await vscode.window.showQuickPick(items, { title: 'Copy SVN command (password masked)', matchOnDetail: true, placeHolder: 'Select a command to copy' });
    if (!pick) return;
    await vscode.env.clipboard.writeText(pick.label);
    void vscode.window.showInformationMessage('SVN: command copied. Replace the masked password before running it.');
  });

  reg('svnWorkflow.cmdlog.clear', () => {
    history.clear();
    channel.clear();
  });
}

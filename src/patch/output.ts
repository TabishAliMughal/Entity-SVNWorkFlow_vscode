import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Services } from '../services';

/** Where a generated unified diff goes: a file, an untitled editor or the clipboard. Returns the saved path when written to disk. */
export async function deliverDiff(services: Services, bytes: Buffer, o: { defaultName: string; defaultDir?: string; title?: string }): Promise<string | undefined> {
  type Item = vscode.QuickPickItem & { id: 'save' | 'open' | 'copy' };
  const pick = await vscode.window.showQuickPick<Item>(
    [
      { id: 'save', label: '$(save) Save to a file...' },
      { id: 'open', label: '$(go-to-file) Open in an editor' },
      { id: 'copy', label: '$(clippy) Copy to the clipboard' },
    ],
    { title: o.title ?? 'Unified diff ready', placeHolder: 'What should happen with it?' },
  );
  if (!pick) return undefined;
  const text = bytes.toString('utf8');
  if (pick.id === 'copy') {
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage('SVN: Unified diff copied to the clipboard.');
    return undefined;
  }
  if (pick.id === 'open') {
    const doc = await vscode.workspace.openTextDocument({ content: text, language: 'diff' });
    await vscode.window.showTextDocument(doc, { preview: false });
    return undefined;
  }
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(o.defaultDir ?? process.cwd(), o.defaultName)),
    filters: { Patch: ['patch', 'diff'], 'All files': ['*'] },
    saveLabel: 'Save Patch',
  });
  if (!target) return undefined;
  await fs.writeFile(target.fsPath, bytes);
  services.logger.info(`Wrote unified diff to ${target.fsPath}`);
  const open = await vscode.window.showInformationMessage(`SVN: Saved ${path.basename(target.fsPath)}.`, 'Open');
  if (open) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target), { preview: false });
  return target.fsPath;
}

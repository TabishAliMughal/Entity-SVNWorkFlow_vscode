import * as vscode from 'vscode';
import type { Services } from '../services';
import { pegSafe } from '../svn/client';
import { parseLog } from '../svn/xml';
import type { Rev } from './fetch';

/** Quick pick: HEAD, recent revisions of the target (svn log), or a typed number. */
export async function pickRevision(services: Services, repoName: string, target: string): Promise<Rev | undefined> {
  type Item = vscode.QuickPickItem & { rev?: Rev; manual?: boolean };
  const items: Item[] = [{ label: 'HEAD', description: 'latest on the server', rev: 'HEAD' }, { label: '$(edit) Enter revision number...', manual: true }];
  try {
    const r = await services.client.run(['log', '-l', '40', '--', pegSafe(target)], { repoName, xml: true });
    for (const e of parseLog(r.text)) {
      items.push({
        label: `r${e.revision}`,
        description: `${e.author ?? ''} ${e.date ? e.date.slice(0, 10) : ''}`.trim(),
        detail: (e.message ?? '').split(/\r?\n/)[0],
        rev: e.revision,
      });
    }
  } catch (e) {
    services.logger.warn(`svn log for revision picker failed: ${(e as Error).message}`);
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Compare local file with which revision?', matchOnDescription: true, matchOnDetail: true });
  if (!pick) return undefined;
  if (pick.manual) {
    const v = await vscode.window.showInputBox({ prompt: 'Revision number (or HEAD / BASE)', validateInput: (s) => (/^(\d+|HEAD|BASE)$/i.test(s.trim()) ? undefined : 'Enter a number, HEAD or BASE') });
    if (!v) return undefined;
    const t = v.trim().toUpperCase();
    return t === 'HEAD' || t === 'BASE' ? t : Number(t);
  }
  return pick.rev;
}

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Services } from '../services';
import { fetchContent, resolveCatTarget, type Rev } from './fetch';

export const INCOMING_SCHEME = 'svnworkflow-incoming';

interface Query {
  repo: string;
  target: string;
  rev: Rev;
}

/** Virtual read-only document for `svn cat <target>@<rev>` (target = local path or URL). */
export function incomingUri(repo: string, target: string, rev: Rev): vscode.Uri {
  const q: Query = { repo, target, rev };
  const name = decodeURIComponent(target.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'file');
  return vscode.Uri.from({ scheme: INCOMING_SCHEME, path: `/${rev}/${name}`, query: JSON.stringify(q) });
}

export class IncomingContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly services: Services) {}

  async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
    const q = JSON.parse(uri.query) as Query;
    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());
    const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(q.target);
    const target = isUrl ? q.target : await resolveCatTarget(this.services.client, q.repo, path.resolve(q.target));
    const f = await fetchContent(this.services.client, { repoName: q.repo, target, rev: q.rev }, ac.signal);
    if (f.binary) return `[Binary file at ${q.rev}: content not shown]`;
    return f.text;
  }
}

import * as vscode from 'vscode';
import type { ExternalsChoice, ExternalsPrompt } from '../externals/guard';
import type { RepoEntry } from '../repos/model';
import { CertInfo, probeCertificate } from '../svn/certificate';

function certDetail(info: CertInfo): string {
  return [
    `Server: ${info.host}:${info.port}`,
    `Subject: ${info.subject || '(unknown)'}`,
    `Issuer: ${info.issuer || '(unknown)'}`,
    `Valid: ${info.validFrom} until ${info.validTo}`,
    `SHA-1 fingerprint: ${info.fingerprint}`,
    info.hostnameMatches ? 'Host name: matches the certificate' : 'Host name: DOES NOT MATCH the certificate',
  ].join('\n');
}

export type CertConfirmation = { trusted: true; fingerprint?: string } | { trusted: false };

/**
 * Modal confirmation before `trustServerCert` is enabled: shows what the server presents so the user can compare it
 * with the fingerprint their administrator published. The fingerprint is returned so it can be pinned.
 */
export async function confirmCertificateTrust(url: string, why = 'Trust this certificate?'): Promise<CertConfirmation> {
  if (!/^https:\/\//i.test(url)) return { trusted: false };
  let info: CertInfo | undefined;
  let failure = '';
  try {
    info = await probeCertificate(url);
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  const ok = await vscode.window.showWarningMessage(
    info ? `${why} ${url}` : `The certificate of ${url} could not be read. Trust it anyway?`,
    {
      modal: true,
      detail: info
        ? `${certDetail(info)}\n\nTrusting accepts self-signed, unknown-CA and host-name-mismatch certificates for this repository, but only this fingerprint; a different certificate is refused until you confirm it again.`
        : `${failure}\n\nWithout a fingerprint nothing can be pinned: any certificate presented by this server would be accepted.`,
    },
    'Trust Certificate',
  );
  if (!ok) return { trusted: false };
  return { trusted: true, fingerprint: info?.fingerprint };
}

export async function confirmCertificateChanged(repo: RepoEntry, info: CertInfo): Promise<boolean> {
  const ok = await vscode.window.showWarningMessage(
    `The certificate of "${repo.name}" changed. This may mean the connection is being intercepted.`,
    {
      modal: true,
      detail: `Confirmed earlier: ${repo.trustedCertFingerprint}\nPresented now:\n${certDetail(info)}\n\nOnly continue if your administrator renewed the certificate.`,
    },
    'Trust New Certificate',
  );
  return !!ok;
}

export async function promptExternals(p: ExternalsPrompt): Promise<ExternalsChoice> {
  const first = p.lines.slice(0, 8).join('\n');
  const more = p.lines.length > 8 ? `\n... and ${p.lines.length - 8} more` : '';
  const buttons: Array<{ label: string; choice: ExternalsChoice }> = [{ label: 'Update without externals', choice: 'ignore' }];
  if (p.canSeparate) buttons.push({ label: 'Update externals without credentials', choice: 'separate' });
  buttons.push({ label: 'Continue (trusted)', choice: 'continue' });
  if (p.canTrust) buttons.push({ label: 'Always trust for this repo', choice: 'trust' });
  const pick = await vscode.window.showWarningMessage(
    `This working copy has externals on other servers (${p.origins.join(', ') || 'unknown'}). Credentials for ${p.repoName} would be offered to them.`,
    { modal: true, detail: `${first}${more}\n\nRepository: ${p.repoUrl}` },
    ...buttons.map((b) => b.label),
  );
  return buttons.find((b) => b.label === pick)?.choice ?? 'cancel';
}

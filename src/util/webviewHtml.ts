export interface WebviewPage {
  /** `webview.cspSource`. */
  cspSource: string;
  nonce: string;
  title: string;
  /** Webview URIs (strings) of the script and stylesheet under media/. */
  scriptUri: string;
  styleUri: string;
  /** Static markup of <body>; must not contain user data (the script renders that from messages). */
  body: string;
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Strict CSP: no inline script, scripts only with the nonce, no network. Styles only from the extension unless `inlineStyles` (Monaco injects <style> rules at runtime). */
export function contentSecurityPolicy(cspSource: string, nonce: string, opts: { inlineStyles?: boolean } = {}): string {
  const style = opts.inlineStyles ? `${cspSource} 'unsafe-inline'` : cspSource;
  return `default-src 'none'; style-src ${style}; script-src 'nonce-${nonce}'; img-src ${cspSource} data:; font-src ${cspSource}; base-uri 'none'; form-action 'none';`;
}

export function webviewHtml(p: WebviewPage): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${esc(contentSecurityPolicy(p.cspSource, p.nonce))}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${esc(p.styleUri)}">
<title>${esc(p.title)}</title>
</head>
<body>
${p.body}
<script nonce="${esc(p.nonce)}" src="${esc(p.scriptUri)}"></script>
</body>
</html>`;
}

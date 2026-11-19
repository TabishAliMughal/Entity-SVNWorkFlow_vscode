const BY_EXT: Record<string, string> = {
  php: 'php', phtml: 'php', inc: 'php',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xhtml: 'xml', xml: 'xml', svg: 'xml', xsl: 'xml', xsd: 'xml', csproj: 'xml', config: 'xml', tpl: 'xml', vue: 'xml',
  sql: 'sql',
  json: 'json', jsonc: 'json',
  yml: 'yaml', yaml: 'yaml',
  md: 'markdown', markdown: 'markdown',
  py: 'python', java: 'java', cs: 'csharp',
  sh: 'bash', bash: 'bash', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'properties',
  c: 'cpp', h: 'cpp', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  go: 'go', rb: 'ruby', rs: 'rust', ps1: 'powershell', diff: 'diff', patch: 'diff',
};

/** highlight.js language id for a file name, or undefined (render plain). */
export function languageFor(fileName: string): string | undefined {
  const base = fileName.toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  const i = base.lastIndexOf('.');
  return i < 0 ? undefined : BY_EXT[base.slice(i + 1)];
}

/** hljs ids that differ from the Monaco language id (Monaco has a real html language and calls bash "shell"). */
const MONACO_ID: Record<string, string> = { bash: 'shell', properties: 'ini' };
const MONACO_BY_EXT: Record<string, string> = { html: 'html', htm: 'html', xhtml: 'html', tpl: 'html', vue: 'html' };

/** Monaco language id for a file name (the compare view's editors); undefined = plain text. */
export function monacoLanguageFor(fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf('.') + 1);
  const hl = languageFor(fileName);
  if (!hl || hl === 'diff') return undefined;
  return (lower.includes('.') && MONACO_BY_EXT[ext]) || MONACO_ID[hl] || hl;
}

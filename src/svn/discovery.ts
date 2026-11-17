import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DiscoveryOptions {
  customPath?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
}

export interface DiscoveryResult {
  path?: string;
  source?: 'setting' | 'tortoiseSvn' | 'path';
  /** Locations that were checked, for the error message. */
  tried: string[];
}

const EXE = 'svn.exe';

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Accepts either the exe path or its containing folder. */
function resolveCustom(p: string, exists: (p: string) => boolean): string | undefined {
  const trimmed = p.trim().replace(/^"|"$/g, '');
  if (!trimmed) return undefined;
  if (/\.exe$/i.test(trimmed) && exists(trimmed)) return trimmed;
  const inDir = path.win32.join(trimmed, EXE);
  return exists(inDir) ? inDir : undefined;
}

export function findSvnExe(opts: DiscoveryOptions = {}): DiscoveryResult {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? isFile;
  const tried: string[] = [];

  if (opts.customPath?.trim()) {
    const hit = resolveCustom(opts.customPath, exists);
    tried.push(opts.customPath.trim());
    if (hit) return { path: hit, source: 'setting', tried };
  }

  const roots = [env['ProgramFiles'], env['ProgramFiles(x86)'], env['ProgramW6432'], 'C:\\Program Files', 'C:\\Program Files (x86)']
    .filter((x): x is string => !!x);
  const seen = new Set<string>();
  for (const root of roots) {
    const candidate = path.win32.join(root, 'TortoiseSVN', 'bin', EXE);
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tried.push(candidate);
    if (exists(candidate)) return { path: candidate, source: 'tortoiseSvn', tried };
  }

  const pathVar = env['PATH'] ?? env['Path'] ?? '';
  for (const dir of pathVar.split(';').map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    const candidate = path.win32.join(dir, EXE);
    if (exists(candidate)) return { path: candidate, source: 'path', tried: [...tried, 'PATH'] };
  }
  tried.push('PATH');
  return { tried };
}

export function notFoundMessage(res: DiscoveryResult, customPath?: string): string {
  const custom = customPath?.trim()
    ? `The configured path "${customPath.trim()}" does not point to svn.exe. `
    : '';
  return (
    `${custom}svn.exe was not found. Install TortoiseSVN and, in the installer, enable ` +
    `"command line client tools" (re-run the installer and choose Modify), or set "svnWorkflow.svnPath" ` +
    `to the full path of svn.exe. Searched: ${res.tried.join('; ')}.`
  );
}

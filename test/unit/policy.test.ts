import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const SRC = sourceFiles(path.join(root, 'src')).map((f) => ({ file: path.relative(root, f).replace(/\\/g, '/'), text: fs.readFileSync(f, 'utf8') }));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  contributes: { menus?: Record<string, Array<{ when?: string }>> };
};

describe('D14/D15: no built-in diff editor, no Myers diff library', () => {
  it('src never calls the vscode.diff command', () => {
    const offenders = SRC.filter((s) => /['"`]vscode\.diff['"`]/.test(s.text) || /executeCommand\(\s*['"`]vscode\.diff/.test(s.text)).map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it('package.json contributes no menu or command that targets vscode.diff', () => {
    expect(JSON.stringify(pkg.contributes)).not.toMatch(/vscode\.diff/);
  });

  it('no diff library is a dependency', () => {
    const banned = /^(diff|jsdiff|diff-match-patch|diff-match-patch-es|fast-diff|myers-diff|myers-difference|diff2html|diff-sequences|jest-diff|text-diff|fast-myers-diff|@sanity\/diff-match-patch)$/i;
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    expect(names.filter((n) => banned.test(n))).toEqual([]);
  });

  it('src does not import a diff library', () => {
    const re = /from\s+['"](diff|jsdiff|diff-match-patch[\w-]*|fast-diff|myers-diff|diff-sequences|jest-diff)['"]/;
    expect(SRC.filter((s) => re.test(s.text)).map((s) => s.file)).toEqual([]);
  });
});

describe('credential handling (H2)', () => {
  it('only the client puts --password on a command line (old-svn fallback)', () => {
    const offenders = SRC.filter((s) => /['"]--password['"]/.test(s.text) && !['src/svn/client.ts', 'src/util/redact.ts'].includes(s.file)).map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it('no call site feeds svn through stdin other than the password', () => {
    const offenders = SRC.filter((s) => /stdin\s*:/.test(s.text) && !['src/svn/client.ts', 'src/svn/runner.ts'].includes(s.file)).map((s) => s.file);
    expect(offenders).toEqual([]);
  });
});

describe('scratch files (L5)', () => {
  it('src never falls back to the OS temp folder', () => {
    expect(SRC.filter((s) => /os\.tmpdir|node:os/.test(s.text) && s.file !== 'src/svn/discovery.ts').map((s) => s.file)).toEqual([]);
  });
});

describe('webviews', () => {
  it('only the shared builder spells out a Content-Security-Policy, and it forbids base and form targets', () => {
    expect(SRC.filter((s) => /default-src/.test(s.text)).map((s) => s.file)).toEqual(['src/util/webviewHtml.ts']);
    const html = SRC.find((s) => s.file === 'src/util/webviewHtml.ts')?.text ?? '';
    expect(html).toContain("base-uri 'none'");
    expect(html).toContain("form-action 'none'");
    expect(html).toContain("default-src 'none'");
  });

  it('no webview may load the whole dist or media folder', () => {
    const offenders = SRC.filter((s) => /joinPath\([^)]*,\s*'(dist|media)'\)/.test(s.text)).map((s) => s.file);
    expect(offenders).toEqual([]);
  });
});

describe('package manifest (M1, M3)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    capabilities?: { untrustedWorkspaces?: { supported?: string; restrictedConfigurations?: string[] }; virtualWorkspaces?: boolean };
    contributes: { configuration: { properties: Record<string, { scope?: string }> } };
  };
  const props = manifest.contributes.configuration.properties;

  it('declares limited untrusted workspace support and no virtual workspaces', () => {
    expect(manifest.capabilities?.untrustedWorkspaces?.supported).toBe('limited');
    expect(manifest.capabilities?.virtualWorkspaces).toBe(false);
    for (const k of manifest.capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? []) expect(props[k], k).toBeDefined();
  });

  it('settings that choose what runs or what is scanned are machine scoped', () => {
    for (const k of ['svnWorkflow.svnPath', 'svnWorkflow.commandLog.verbosity', 'svnWorkflow.shelve.mode', 'svnWorkflow.override.backupMaxAgeDays']) {
      expect(props[k]?.scope, k).toBe('machine');
    }
  });

  it('.vscodeignore keeps build and lock files out of the package', () => {
    const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
    for (const e of ['package-lock.json', 'tsconfig*.json', '*.vsix']) expect(ignore).toContain(e);
  });
});

/** Index of the paren that closes the one opened at `open`. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return text.length;
}

describe('repo lock coverage (testing finding 1)', () => {
  // Every mutating call must sit inside a withRepoLock / withRepoLocks / withRepoLockStrict callback.
  const GUARDED: Array<{ file: string; calls: string[] }> = [
    { file: 'src/conflict/register.ts', calls: ['resolvePaths'] },
    { file: 'src/conflict/sessions.ts', calls: ['resolvePaths', 'applyProperty'] },
    { file: 'src/conflict/tree.ts', calls: ['runTreeSteps'] },
    { file: 'src/props/register.ts', calls: ['applyChanges'] },
    { file: 'src/props/panel.ts', calls: ['applyChanges'] },
    { file: 'src/locks/register.ts', calls: ['lockPaths', 'unlockPaths'] },
    { file: 'src/changelist/register.ts', calls: ['addToChangelist', 'removeFromChangelist', 'renameChangelist', 'clearChangelist'] },
  ];
  for (const g of GUARDED) {
    it(`${g.file}: ${g.calls.join(', ')} run under the repo lock`, () => {
      const text = SRC.find((s) => s.file === g.file)?.text ?? '';
      const wrappers = [...text.matchAll(/withRepoLock(?:s|Strict)?\(/g)].map((m) => ({ from: m.index as number, to: closingParen(text, (m.index as number) + m[0].length - 1) }));
      let seen = 0;
      for (const call of g.calls) {
        for (const m of text.matchAll(new RegExp(`\\b${call}\\(`, 'g'))) {
          const i = m.index as number;
          const before = text.slice(Math.max(0, text.lastIndexOf('\n', i)), i);
          if (/\bimport\b|function\s+$/.test(before) || /export async function/.test(before)) continue;
          seen++;
          expect(wrappers.some((w) => i > w.from && i < w.to), `${g.file}: ${call}( at offset ${i}`).toBe(true);
        }
      }
      expect(seen).toBeGreaterThan(0);
    });
  }
});

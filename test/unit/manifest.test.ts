import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as {
  contributes: { commands: { command: string; category?: string }[]; menus: Record<string, { command?: string; submenu?: string; when?: string }[]>; submenus?: { id: string }[] };
};

function strings(o: unknown, p = ''): Array<[string, string]> {
  if (typeof o === 'string') return [[p, o]];
  if (Array.isArray(o)) return o.flatMap((v, i) => strings(v, `${p}[${i}]`));
  if (o && typeof o === 'object') return Object.entries(o).flatMap(([k, v]) => strings(v, `${p}/${k}`));
  return [];
}

describe('package.json manifest', () => {
  it('has no backspace characters (a single-backslash \b in JSON)', () => {
    expect(strings(pkg.contributes).filter(([, s]) => s.includes('\x08')).map(([p]) => p)).toEqual([]);
  });
  it('declares every command used in menus', () => {
    const declared = new Set(pkg.contributes.commands.map((c) => c.command));
    const used = Object.values(pkg.contributes.menus).flatMap((m) => m.map((e) => e.command).filter((c): c is string => !!c));
    expect([...new Set(used)].filter((c) => !declared.has(c))).toEqual([]);
  });
  it('references only declared submenus', () => {
    const ids = new Set((pkg.contributes.submenus ?? []).map((s) => s.id));
    const used = Object.values(pkg.contributes.menus).flatMap((m) => m.map((e) => e.submenu).filter((c): c is string => !!c));
    expect(used.filter((s) => !ids.has(s))).toEqual([]);
  });

  it('has no duplicate command ids', () => {
    const ids = pkg.contributes.commands.map((c) => c.command);
    expect(ids.filter((c, i) => ids.indexOf(c) !== i)).toEqual([]);
  });
  it('has no duplicate menu entries', () => {
    const dups: string[] = [];
    for (const [menu, entries] of Object.entries(pkg.contributes.menus)) {
      const seen = new Set<string>();
      for (const e of entries) {
        const key = JSON.stringify(e);
        if (seen.has(key)) dups.push(`${menu}: ${key}`);
        seen.add(key);
      }
    }
    expect(dups).toEqual([]);
  });
  it('uses the single category "SVN" for every command', () => {
    expect(pkg.contributes.commands.filter((c) => c.category !== 'SVN').map((c) => c.command)).toEqual([]);
  });
  it('gives every setting a title or description', () => {
    const cfg = (pkg.contributes as unknown as { configuration: { properties: Record<string, { title?: string; description?: string; markdownDescription?: string }> } }).configuration.properties;
    expect(Object.entries(cfg).filter(([, v]) => !(v.title || v.description || v.markdownDescription)).map(([k]) => k)).toEqual([]);
  });
});

function srcFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'webview' ? [] : srcFiles(full);
    return d.name.endsWith('.ts') ? [full] : [];
  });
}

describe('command and module wiring (static scan of src/)', () => {
  const root = path.resolve(__dirname, '..', '..', 'src');
  const files = srcFiles(root).map((f) => ({ f, text: fs.readFileSync(f, 'utf8') }));
  const all = files.map((x) => x.text).join('\n');

  it('registers every contributed command', () => {
    // `reg` is the local alias several register files define around registerCommand.
    const consts = new Map([...all.matchAll(/const (\w+) = ['"`](svnWorkflow\.[\w.]+)['"`]/g)].map((m) => [m[1], m[2]]));
    const re = /\b(?:registerCommand|registerSvnCommand|registerRepoCommand|registerSelectionCommand|registerWc|registerOptional|reg)\(\s*(?:context,\s*services,\s*)?(?:['"`](svnWorkflow\.[\w.]+)['"`]|([A-Z_]+))/g;
    const registered = new Set([...all.matchAll(re)].map((m) => m[1] ?? consts.get(m[2]) ?? ''));
    // Data-driven registration: `reg(c.command, ...)` over a table of `command: 'svnWorkflow.x'` entries in the same folder.
    for (const { f, text } of files) {
      if (!/reg\(\w+\.command\b/.test(text)) continue;
      for (const o of files.filter((x) => path.dirname(x.f) === path.dirname(f))) for (const m of o.text.matchAll(/command: ['"`](svnWorkflow\.[\w.]+)['"`]/g)) registered.add(m[1]);
    }
    const missing = pkg.contributes.commands.map((c) => c.command).filter((c) => !registered.has(c));
    expect(missing).toEqual([]);
  });

  it('calls every exported register* feature function from extension.ts (directly or via a wired module)', () => {
    const helpers = new Set(['registerSvnCommand', 'registerRepoCommand', 'registerSelectionCommand']);
    const defs = new Map<string, string>();
    for (const { f, text } of files) {
      for (const m of text.matchAll(/export function (register[A-Z]\w*)\(/g)) if (!helpers.has(m[1])) defs.set(m[1], f);
    }
    const ext = files.find((x) => x.f.endsWith('extension.ts'))!.text;
    const wired = new Set<string>();
    const callsRe = (name: string): RegExp => new RegExp(String.raw`\b${name}\(`);
    for (const name of defs.keys()) if (callsRe(name).test(ext)) wired.add(name);
    for (let changed = true; changed; ) {
      changed = false;
      for (const [name, file] of defs) {
        if (wired.has(name)) continue;
        const callers = files.filter((x) => x.f !== file && callsRe(name).test(x.text));
        const viaWired = callers.some((c) => [...wired].some((w) => defs.get(w) === c.f) || c.f.endsWith('extension.ts'));
        const viaFactory = callers.some((c) => /export function create\w+\(/.test(c.text));
        if (viaWired || viaFactory) {
          wired.add(name);
          changed = true;
        }
      }
    }
    expect([...defs.keys()].filter((n) => !wired.has(n))).toEqual([]);
  });
});

import { monaco } from './monaco';

/** Colour ids shared by VS Code and Monaco; the webview exposes each as `--vscode-<id with dots as dashes>`. */
const COLOR_IDS = [
  'editor.background', 'editor.foreground', 'editorLineNumber.foreground', 'editorLineNumber.activeForeground', 'editorCursor.foreground',
  'editor.selectionBackground', 'editor.inactiveSelectionBackground', 'editor.selectionHighlightBackground', 'editor.wordHighlightBackground',
  'editor.wordHighlightStrongBackground', 'editor.findMatchBackground', 'editor.findMatchHighlightBackground', 'editor.findRangeHighlightBackground',
  'editor.lineHighlightBackground', 'editor.lineHighlightBorder', 'editor.foldBackground', 'editorIndentGuide.background1', 'editorIndentGuide.activeBackground1',
  'editorWhitespace.foreground', 'editorBracketMatch.background', 'editorBracketMatch.border', 'editorGutter.background', 'editorOverviewRuler.border',
  'editorWidget.background', 'editorWidget.foreground', 'editorWidget.border', 'editorWidget.resizeBorder', 'editorError.foreground', 'editorWarning.foreground',
  'input.background', 'input.foreground', 'input.border', 'inputOption.activeBackground', 'inputOption.activeBorder', 'inputOption.activeForeground',
  'inputValidation.errorBackground', 'inputValidation.errorBorder', 'button.background', 'button.foreground', 'scrollbar.shadow',
  'scrollbarSlider.background', 'scrollbarSlider.hoverBackground', 'scrollbarSlider.activeBackground', 'focusBorder', 'foreground', 'descriptionForeground',
  'menu.background', 'menu.foreground', 'menu.selectionBackground', 'menu.selectionForeground', 'menu.separatorBackground', 'menu.border',
  'widget.shadow', 'icon.foreground', 'toolbar.hoverBackground', 'list.hoverBackground', 'list.activeSelectionBackground', 'list.activeSelectionForeground',
  'contrastBorder', 'contrastActiveBorder',
];

const root = document.documentElement;
const cssVar = (name: string): string => getComputedStyle(root).getPropertyValue(name).trim();
const hex2 = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** `#rgb`, `#rrggbb[aa]`, `rgb()` and `rgba()` to `#rrggbb[aa]`; anything else is undefined. */
export function toHex(v: string): string | undefined {
  const s = v.trim();
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return '#' + [...s.slice(1)].map((c) => c + c).join('').toLowerCase();
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (!m) return undefined;
  const a = m[4] === undefined ? undefined : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return `#${hex2(+m[1])}${hex2(+m[2])}${hex2(+m[3])}${a === undefined || a >= 1 ? '' : hex2(a * 255)}`;
}

/** A `--vscode-*` variable as `#rrggbb` (alpha dropped), or the fallback. */
export function colorVar(name: string, fallback: string): string {
  return toHex(cssVar(name))?.slice(0, 7) ?? fallback;
}

/** `pct`% of `a` over `b` (both `#rrggbb`). */
export function mix(a: string, b: string, pct: number): string {
  const c = (h: string, i: number): number => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  return '#' + [0, 1, 2].map((i) => hex2((c(a, i) * pct) / 100 + (c(b, i) * (100 - pct)) / 100)).join('');
}

function themeBase(): monaco.editor.BuiltinTheme {
  const c = document.body.classList;
  if (c.contains('vscode-high-contrast-light')) return 'hc-light';
  if (c.contains('vscode-high-contrast')) return 'hc-black';
  return c.contains('vscode-light') ? 'vs' : 'vs-dark';
}

export const THEME = 'svnwf';

/** Maps the active VS Code theme (kind plus every `--vscode-*` colour) onto a Monaco theme. Token colours stay those of the matching built-in theme: webviews cannot read the theme's token rules. */
export function applyTheme(): void {
  const colors: Record<string, string> = {};
  for (const id of COLOR_IDS) {
    const hex = toHex(cssVar('--vscode-' + id.replace(/\./g, '-')));
    if (hex) colors[id] = hex;
  }
  monaco.editor.defineTheme(THEME, { base: themeBase(), inherit: true, rules: [], colors });
  monaco.editor.setTheme(THEME);
}

export interface FontSettings {
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
}

export function editorFont(): FontSettings {
  return {
    fontFamily: cssVar('--vscode-editor-font-family') || 'Consolas, "Courier New", monospace',
    fontSize: parseFloat(cssVar('--vscode-editor-font-size')) || 14,
    fontWeight: cssVar('--vscode-editor-font-weight') || 'normal',
  };
}

/** Calls `cb` when VS Code switches theme or changes editor font settings (it rewrites the root style and the body class). */
export function watchTheme(cb: () => void): void {
  let t: number | undefined;
  const fire = (): void => {
    clearTimeout(t);
    t = window.setTimeout(cb, 50);
  };
  const mo = new MutationObserver(fire);
  mo.observe(root, { attributes: true, attributeFilter: ['style'] });
  mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

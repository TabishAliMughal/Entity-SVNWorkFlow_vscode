import { monaco } from './monaco';
import { el } from './dom';
import { applyTheme, colorVar, editorFont, mix, THEME, watchTheme } from './theme';
import { buildRows, hunkRowStarts, hunkSpans, type HunkSpan } from '../rows';
import { renderedLabel, sectionLabel, showsSectionLabel, sideTitle, type CompactBlame } from '../annotate';
import type { DataMessage, FromWebview, ToWebview } from '../protocol';

interface VsCodeApi {
  postMessage(m: FromWebview): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

type Side = 'left' | 'right';
const SIDES: Side[] = ['left', 'right'];
const GUTTER_W = 48;
const BTN_W = 26;
const BTN_H = 18;
const SVG_NS = 'http://www.w3.org/2000/svg';

let data: DataMessage | undefined;
let spans: HunkSpan[] = [];
let starts: number[] = [];
let cur = -1;
let typing: Side | null = null;
let seq = 0;
let sentSeq = 0;
/** True while a remote text (extension -> view) is written into a model, so it is not echoed back as an edit. */
let applyingRemote = false;
/** Blame of the incoming (revision) side, used for the section labels. */
let rightBlame: CompactBlame | undefined;
const models: Record<Side, monaco.editor.ITextModel | undefined> = { left: undefined, right: undefined };
const modelKey: Record<Side, string> = { left: '', right: '' };
const zoneIds: Record<Side, string[]> = { left: [], right: [] };

const app = document.getElementById('app') as HTMLElement;
const bar = el('div', 'toolbar');
const banner = el('div', 'banner');
const heads = el('div', 'heads');
const leftHead = el('div', 'head');
const gutterHead = el('div', 'ghead');
const rightHead = el('div', 'head');
heads.append(leftHead, gutterHead, rightHead);
const main = el('div', 'main');
const hosts = { left: el('div', 'ehost'), right: el('div', 'ehost') };
const gutter = el('div', 'gutter');
const gBox = el('div', 'gbox');
gutter.append(gBox);
main.append(hosts.left, gutter, hosts.right);
const noticeEl = el('div', 'notice');
app.append(bar, banner, heads, main, noticeEl);

const btn = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
  const b = el('button', undefined, label);
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
};
const prevBtn = btn('▲ Prev', 'Previous change (Shift+F7)', () => goto(-1));
const nextBtn = btn('▼ Next', 'Next change (F7)', () => goto(1));
const counter = el('span', 'counter');
const pullAllBtn = btn('Pull all', 'Pull every change into the local file', () => data && vscode.postMessage({ type: 'pullAll', version: data.version }));
const wsSel = el('select');
for (const [v, t] of [['none', 'Whitespace: compare'], ['trailing', 'Whitespace: ignore trailing'], ['all', 'Whitespace: ignore all']]) {
  const o = el('option', undefined, t);
  o.value = v;
  wsSel.append(o);
}
const caseCb = el('input');
caseCb.type = 'checkbox';
const eolCb = el('input');
eolCb.type = 'checkbox';
const lab = (cb: HTMLInputElement, t: string): HTMLLabelElement => {
  const l = el('label');
  l.append(cb, document.createTextNode(' ' + t));
  return l;
};
const openBtn = btn('Open in editor', 'Open the local file in a normal editor at the caret', () => {
  if (!data) return;
  const side = data.editable ?? 'left';
  vscode.postMessage({ type: 'openAt', side, line: (editors[side].getPosition()?.lineNumber ?? 1) - 1 });
});
const revBtn = btn('Revision…', 'Compare with another revision', () => vscode.postMessage({ type: 'pickRevision' }));
const refreshBtn = btn('Refresh', 'Re-read both sides', () => vscode.postMessage({ type: 'refresh' }));
const busyEl = el('span', 'busy', '');
const sendOptions = (): void =>
  vscode.postMessage({ type: 'options', ignoreWhitespace: wsSel.value as 'none' | 'trailing' | 'all', ignoreEol: eolCb.checked, ignoreCase: caseCb.checked });
wsSel.addEventListener('change', sendOptions);
caseCb.addEventListener('change', sendOptions);
eolCb.addEventListener('change', sendOptions);
bar.append(prevBtn, nextBtn, counter, pullAllBtn, openBtn, wsSel, lab(caseCb, 'Ignore case'), lab(eolCb, 'Ignore EOL'), revBtn, refreshBtn, busyEl);

applyTheme();

function editorOptions(side: Side): monaco.editor.IStandaloneEditorConstructionOptions {
  const f = editorFont();
  return {
    model: null,
    theme: THEME,
    ...f,
    readOnly: true,
    // VS Code's webview host blocks the native Ctrl+V and re-issues execCommand('paste'), which a textarea receives as a paste event but Monaco's EditContext element does not
    editContext: false,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    smoothScrolling: false,
    wordWrap: 'off',
    folding: true,
    glyphMargin: false,
    lineNumbersMinChars: 4,
    renderWhitespace: 'selection',
    fixedOverflowWidgets: true,
    stickyScroll: { enabled: false },
    // features that would need a language-service or editor worker
    unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false },
    links: false,
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    wordBasedSuggestions: 'off',
    parameterHints: { enabled: false },
    hover: { enabled: 'off' },
    colorDecorators: false,
    renderValidationDecorations: 'off',
    // the right side carries the visible scrollbar and overview ruler; both sides scroll together
    overviewRulerLanes: side === 'right' ? 3 : 0,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    scrollbar: { vertical: side === 'right' ? 'auto' : 'hidden', horizontal: 'visible', useShadows: false, alwaysConsumeMouseWheel: false },
  };
}

const editors: Record<Side, monaco.editor.IStandaloneCodeEditor> = {
  left: monaco.editor.create(hosts.left, editorOptions('left')),
  right: monaco.editor.create(hosts.right, editorOptions('right')),
};
const decorations = { left: editors.left.createDecorationsCollection(), right: editors.right.createDecorationsCollection() };

function lineHeight(): number {
  return editors.left.getOption(monaco.editor.EditorOption.lineHeight);
}

function textOf(lines: string[], endsWithEol: boolean): string {
  return lines.join('\n') + (endsWithEol && lines.length ? '\n' : '');
}

/** Writes `text` into the model as one minimal edit (keeps cursors, scroll and the undo stack of the editor). */
function syncModel(model: monaco.editor.ITextModel, text: string): void {
  const old = model.getValue();
  if (old === text) return;
  let p = 0;
  const max = Math.min(old.length, text.length);
  while (p < max && old.charCodeAt(p) === text.charCodeAt(p)) p++;
  let so = old.length;
  let st = text.length;
  while (so > p && st > p && old.charCodeAt(so - 1) === text.charCodeAt(st - 1)) {
    so--;
    st--;
  }
  applyingRemote = true;
  try {
    model.pushStackElement();
    model.pushEditOperations([], [{ range: monaco.Range.fromPositions(model.getPositionAt(p), model.getPositionAt(so)), text: text.slice(p, st) }], () => null);
    model.pushStackElement();
  } finally {
    applyingRemote = false;
  }
}

function setModel(side: Side, name: string, lang: string | undefined, text: string): void {
  const key = `${name}|${lang ?? ''}`;
  if (models[side] && modelKey[side] === key) {
    syncModel(models[side] as monaco.editor.ITextModel, text);
    return;
  }
  const old = models[side];
  const m = monaco.editor.createModel(text, lang ?? 'plaintext');
  m.setEOL(monaco.editor.EndOfLineSequence.LF);
  m.onDidChangeContent((e) => {
    if (applyingRemote || typing !== side) return;
    seq++;
    sentSeq = seq;
    // Monaco reports the changes of one event in the coordinates of the text before it (last change first)
    vscode.postMessage({
      type: 'edit',
      seq,
      edits: e.changes.map((c) => ({
        start: { line: c.range.startLineNumber - 1, col: c.range.startColumn - 1 },
        end: { line: c.range.endLineNumber - 1, col: c.range.endColumn - 1 },
        text: c.text,
      })),
    });
  });
  models[side] = m;
  modelKey[side] = key;
  editors[side].setModel(m);
  old?.dispose();
}

for (const side of SIDES) {
  editors[side].addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    if (typing) vscode.postMessage({ type: 'save' });
  });
}

function applyData(d: DataMessage): void {
  data = d;
  typing = d.typing ? d.editable : null;
  for (const w of SIDES) {
    const info = d[w];
    if (info.lines) {
      if (w === 'right') rightBlame = undefined;
      setModel(w, info.name, info.lang, textOf(info.lines, info.endsWithEol));
    }
    editors[w].updateOptions({ readOnly: typing !== w });
  }
  const rows = buildRows(d.blocks);
  starts = hunkRowStarts(rows);
  spans = hunkSpans(rows);
  if (cur >= starts.length) cur = starts.length - 1;

  wsSel.value = d.options.ignoreWhitespace;
  eolCb.checked = d.options.ignoreEol;
  caseCb.checked = d.options.ignoreCase;
  openBtn.hidden = !d[d.editable ?? 'left'].openable;
  revBtn.hidden = !d.canPickRevision;
  pullAllBtn.hidden = !d.editable || !d.hunks.length;
  pullAllBtn.title = d.editable === 'right' ? 'Pull every change into the right file' : 'Pull every change into the local file';

  banner.textContent = d.upToDate ?? (d.identical ? 'The two sides are identical.' : '');
  banner.hidden = !banner.textContent;

  for (const [head, info] of [[leftHead, d.left], [rightHead, d.right]] as const) {
    head.textContent = `${sideTitle(info.label, info.meta, info.isBase)}${info.dirty ? ' ●' : ''}  ·  ${info.lineCount} lines  ·  ${info.encoding}`;
    head.title = info.meta?.date ? `${info.label} (${info.meta.date.slice(0, 10)})` : info.label;
  }
  gutterHead.textContent = d.editable ? (d.editable === 'left' ? '←' : '→') : '';

  const show = !d.notice;
  main.hidden = heads.hidden = !show;
  noticeEl.hidden = show;
  noticeEl.textContent = d.notice ?? '';
  prevBtn.disabled = nextBtn.disabled = !starts.length;
  updateCounter();
  refreshLayout();
}

function refreshLayout(): void {
  applyZones();
  applyDecorations();
  layoutGutter();
}

function updateCounter(): void {
  counter.textContent = starts.length ? `${cur >= 0 ? cur + 1 : '-'} / ${starts.length} changes` : 'no changes';
}

/** Plain filler blocks so both sides stay row-aligned: the shorter side of each hunk is padded after its last line. */
function applyZones(): void {
  if (!data) return;
  const d = data;
  const lh = lineHeight();
  for (const w of SIDES) {
    const e = editors[w];
    const lines = models[w]?.getLineCount() ?? 0;
    e.changeViewZones((acc) => {
      for (const id of zoneIds[w]) acc.removeZone(id);
      zoneIds[w] = [];
      for (const sp of spans) {
        const have = w === 'left' ? sp.leftCount : sp.rightCount;
        if (have >= sp.count) continue;
        const h = d.hunks[sp.hunk];
        const start = w === 'left' ? h.localStart : h.incomingStart;
        zoneIds[w].push(acc.addZone({ afterLineNumber: Math.min(start + have, lines), heightInPx: (sp.count - have) * lh, domNode: el('div', 'cmp-filler'), suppressMouseDown: true }));
      }
    });
  }
}

function rulerColor(hunk: number): string {
  const fg = colorVar('--vscode-editor-foreground', '#cccccc');
  const bg = colorVar('--vscode-editor-background', '#1e1e1e');
  const c = data?.classes?.[hunk];
  if (c === 'conflict') return colorVar('--vscode-editorError-foreground', '#f14c4c');
  if (c === 'incoming') return colorVar('--vscode-button-background', '#0e639c');
  if (c === 'outgoing' || c === 'mixed') return mix(fg, bg, 42);
  const t = data?.hunks[hunk]?.type;
  return t === 'insert' ? colorVar('--vscode-editorGutter-addedBackground', '#2ea043') : t === 'delete' ? colorVar('--vscode-editorGutter-deletedBackground', '#f85149') : colorVar('--vscode-editorGutter-modifiedBackground', '#1b81a8');
}

/** Line highlights, word marks, overview-ruler markers and the per-section author label. */
function applyDecorations(): void {
  if (!data) return;
  const d = data;
  const out: Record<Side, monaco.editor.IModelDeltaDecoration[]> = { left: [], right: [] };
  const R = monaco.Range;
  d.hunks.forEach((h, i) => {
    const cf = d.classes?.[i] === 'conflict';
    const sfx = (cf ? ' cmp-cf' : '') + (i === cur ? ' cmp-cur' : '');
    const color = rulerColor(i);
    const ranges = { left: [h.localStart, h.localEnd], right: [h.incomingStart, h.incomingEnd] } as const;
    for (const w of SIDES) {
      const [s, e] = ranges[w];
      const m = models[w];
      if (!m) continue;
      const ruler = w === 'right' ? { color, position: monaco.editor.OverviewRulerLane.Full } : undefined;
      if (e > s) {
        out[w].push({ range: new R(s + 1, 1, e, 1), options: { isWholeLine: true, className: (w === 'left' ? 'cmp-del' : 'cmp-ins') + sfx, overviewRuler: ruler } });
      } else if (ruler) {
        const ln = Math.min(Math.max(1, s + 1), m.getLineCount());
        out[w].push({ range: new R(ln, 1, ln, 1), options: { overviewRuler: ruler } });
      }
    }
    const words = h.words;
    if (words) {
      for (const [w, list, cls] of [['left', words.local, 'cmp-w-del'], ['right', words.incoming, 'cmp-w-ins']] as const) {
        for (const r of list) out[w].push({ range: new R(r.line + 1, r.start + 1, r.line + 1, r.end + 1), options: { inlineClassName: cls + (cf ? ' cmp-cf' : '') } });
      }
    }
    const m = models.right;
    const label = rightBlame && showsSectionLabel(d.classes?.[i]) && h.incomingEnd > h.incomingStart ? sectionLabel(rightBlame, h.incomingStart, h.incomingEnd) : undefined;
    if (label && m) {
      const ln = h.incomingStart + 1;
      const col = m.getLineMaxColumn(ln);
      // trailing nbsp: Monaco sizes the scroll width from the glyph run, so padding/margin would not be scrollable into view
      out.right.push({ range: new R(ln, col, ln, col), options: { showIfCollapsed: true, after: { content: renderedLabel(label), inlineClassName: 'cmp-au' } } });
    }
  });
  for (const w of SIDES) decorations[w].set(out[w]);
}

const CLASS_TITLE = {
  incoming: 'Safe to pull',
  outgoing: 'Changed locally (outgoing)',
  conflict: 'Changed locally and on the server',
  mixed: 'Changed locally and on the server in the same section; review before pulling',
} as const;

function classSuffix(hunk: number): string {
  const c = data?.classes?.[hunk];
  return c === 'incoming' ? ' k-in' : c === 'outgoing' ? ' k-out' : c === 'conflict' ? ' k-cf' : c === 'mixed' ? ' k-mx' : '';
}

/** Top (px, content coordinates) of a hunk's first row (where its filler zone starts, if any): the bottom of the line above it. */
function hunkTop(sp: HunkSpan): number {
  const h = data?.hunks[sp.hunk];
  return h && h.localStart > 0 ? editors.left.getBottomForLineNumber(Math.min(h.localStart, models.left?.getLineCount() ?? 1)) : 0;
}

function connector(sp: HunkSpan, top: number, lh: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const yl = sp.leftCount * lh;
  const yr = sp.rightCount * lh;
  const mid = GUTTER_W / 2;
  svg.setAttribute('class', 'conn' + classSuffix(sp.hunk) + (sp.hunk === cur ? ' cur' : ''));
  svg.setAttribute('width', String(GUTTER_W));
  svg.setAttribute('height', String(sp.count * lh));
  svg.style.top = `${top}px`;
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', `M0 0 L${GUTTER_W} 0 L${GUTTER_W} ${yr} C${mid} ${yr} ${mid} ${yl} 0 ${yl} Z`);
  svg.append(path);
  return svg;
}

/** Connectors and pull arrows live in content coordinates; scrolling only moves the whole box. */
function layoutGutter(): void {
  if (!data || data.notice) return;
  const lh = lineHeight();
  const frag = document.createDocumentFragment();
  for (const sp of spans) {
    const top = hunkTop(sp);
    frag.append(connector(sp, top, lh));
    if (data.editable) {
      const b = el('button', 'pull' + classSuffix(sp.hunk), data.editable === 'left' ? '←' : '→');
      b.dataset.hunk = String(sp.hunk);
      const why = CLASS_TITLE[data.classes?.[sp.hunk] ?? 'mixed'];
      b.title = (why ? why + '. ' : '') + (data.editable === 'left' ? 'Pull this change into the left (local) file' : 'Pull this change into the right (local) file');
      b.style.top = `${top + (sp.count * lh) / 2 - BTN_H / 2}px`;
      b.style.left = `${(GUTTER_W - BTN_W) / 2}px`;
      frag.append(b);
    }
  }
  gBox.replaceChildren(frag);
  gBox.style.transform = `translateY(${-editors.left.getScrollTop()}px)`;
}

let layoutQueued = false;
function scheduleGutter(): void {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => {
    layoutQueued = false;
    layoutGutter();
  });
}

let syncingScroll = false;
for (const w of SIDES) {
  const other = editors[w === 'left' ? 'right' : 'left'];
  editors[w].onDidScrollChange((e) => {
    if (e.scrollTopChanged && w === 'left') gBox.style.transform = `translateY(${-e.scrollTop}px)`;
    // a side that clamps to its own narrower width fires its own event; ignoring those keeps the two from chasing each other
    if (syncingScroll || (!e.scrollTopChanged && !e.scrollLeftChanged)) return;
    syncingScroll = true;
    try {
      if (e.scrollTopChanged && other.getScrollTop() !== e.scrollTop) other.setScrollTop(e.scrollTop, monaco.editor.ScrollType.Immediate);
      if (e.scrollLeftChanged && other.getScrollLeft() !== e.scrollLeft) other.setScrollLeft(e.scrollLeft, monaco.editor.ScrollType.Immediate);
    } finally {
      syncingScroll = false;
    }
  });
  editors[w].onDidContentSizeChange(scheduleGutter);
  editors[w].onDidChangeConfiguration((e) => {
    if (e.hasChanged(monaco.editor.EditorOption.lineHeight)) {
      applyZones();
      scheduleGutter();
    }
  });
}
gutter.addEventListener('wheel', (e) => {
  editors.right.setScrollTop(editors.right.getScrollTop() + e.deltaY, monaco.editor.ScrollType.Immediate);
});

gBox.addEventListener('click', (e) => {
  const pull = (e.target as HTMLElement).closest('button.pull') as HTMLButtonElement | null;
  if (pull && data) {
    cur = Number(pull.dataset.hunk);
    vscode.postMessage({ type: 'pull', version: data.version, hunk: Number(pull.dataset.hunk) });
    // the button is outside Monaco: hand focus back so Ctrl+S and typing keep working, caret at the pulled section
    const h = data.hunks[cur];
    const side = data.editable;
    if (side && h) {
      const ed = editors[side];
      ed.setPosition({ lineNumber: Math.min(Math.max(1, (side === 'left' ? h.localStart : h.incomingStart) + 1), ed.getModel()?.getLineCount() ?? 1), column: 1 });
      ed.focus();
    }
  }
});

function goto(dir: number): void {
  if (!starts.length) return;
  cur = cur < 0 ? (dir > 0 ? 0 : starts.length - 1) : (cur + dir + starts.length) % starts.length;
  const sp = spans[cur];
  if (sp) editors.left.setScrollTop(Math.max(0, hunkTop(sp) - editors.left.getLayoutInfo().height / 3), monaco.editor.ScrollType.Immediate);
  updateCounter();
  applyDecorations();
  layoutGutter();
}

// Alt+click (multi-cursor) never sends a key between Alt down and up, so VS Code would read the release as a lone Alt tap
// and move focus to its menu bar (window.customMenuBarAltFocus). Keep that Alt keyup from reaching the host.
let altClicked = false;
window.addEventListener('mousedown', (e) => (altClicked = altClicked || e.altKey), true);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Alt' && !e.repeat) altClicked = false;
}, true);
window.addEventListener('keyup', (e) => {
  if (e.key !== 'Alt' || !altClicked) return;
  altClicked = false;
  e.stopImmediatePropagation();
  e.preventDefault();
}, true);

// Ctrl+S anywhere in the view (Monaco's own binding already handled it when the editor had focus)
window.addEventListener('keydown', (e) => {
  if (typing && !e.defaultPrevented && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    vscode.postMessage({ type: 'save' });
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'F7') {
    e.preventDefault();
    goto(e.shiftKey ? -1 : 1);
  }
});

watchTheme(() => {
  applyTheme();
  const f = editorFont();
  for (const w of SIDES) editors[w].updateOptions(f);
  refreshLayout();
});

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'busy') {
    busyEl.textContent = m.busy ? 'Loading…' : '';
    return;
  }
  if (m.type === 'blame') {
    if (m.side === 'right') {
      rightBlame = m.blame;
      applyDecorations();
    }
    return;
  }
  // Monaco posts its own scheduling messages to this window; only ours carry type 'data'
  if (m.type !== 'data' || m.ackSeq < sentSeq) return;
  applyData(m);
});

vscode.postMessage({ type: 'ready' });

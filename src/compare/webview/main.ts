import { el, highlight } from './shared';
import { arrowTop, buildRows, hunkRowStarts, hunkSpans, shiftRows, type HunkSpan, type Row } from '../rows';
import { markWords, type Range } from '../lineHtml';
import {
  applyEditToLines, clampPos, colAtVisual, comparePos, endPosition, leadingWhitespace, reindent, textInRange, visualCol, wordAt, wordLeft, wordRight, type Pos,
} from '../editing';
import { rowAuthorLabel, sideTitle, type CompactBlame } from '../annotate';
import type { DataMessage, FromWebview, ToWebview } from '../protocol';

interface VsCodeApi {
  postMessage(m: FromWebview): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

const ROW_H = 20;
const BUFFER = 20;
const GUTTER_W = 48;
const BTN_W = 26;
const BTN_H = 18;
/** Left edge of the text in a row: line-number column (52) plus the text padding (4). */
const TEXT_X = 56;
const SVG_NS = 'http://www.w3.org/2000/svg';

interface SideView {
  lines: string[];
  html: string[];
  lang?: string;
  words: Map<number, Range[]>;
  /** `lines` ends with the empty last line of a document that ends with a line break (editable side only). */
  virtual: boolean;
}

const sides: { left: SideView; right: SideView } = {
  left: { lines: [], html: [], words: new Map(), virtual: false },
  right: { lines: [], html: [], words: new Map(), virtual: false },
};
let spans: HunkSpan[] = [];
/** Blame of revision sides (per line), used to label changed sections with their authors. */
const blame: { left?: CompactBlame; right?: CompactBlame } = {};
let typing: 'left' | 'right' | null = null;
let caret: Pos = { line: 0, col: 0 };
let anchor: Pos | null = null;
let want = -1;
let seq = 0;
let sentSeq = 0;
let focused = false;
let composing = false;
let dragging = false;
let useTabs = false;
let maxLen = 1;
let lineRow: number[] = [];
let data: DataMessage | undefined;
let rows: Row[] = [];
let starts: number[] = [];
let cur = -1;
let charW = 8;

const app = document.getElementById('app') as HTMLElement;
const bar = el('div', 'toolbar');
const banner = el('div', 'banner');
const main = el('div', 'main');
const leftHead = el('div', 'head');
const rightHead = el('div', 'head');
const heads = el('div', 'heads');
const gutterHead = el('div', 'ghead');
heads.append(leftHead, gutterHead, rightHead);
const leftPane = el('div', 'pane');
const gutter = el('div', 'gutter');
const rightPane = el('div', 'pane');
const leftBox = el('div', 'box');
const rightBox = el('div', 'box');
const gBox = el('div', 'gbox');
const overlays = { left: el('div', 'overlay'), right: el('div', 'overlay') };
const ta = el('textarea', 'cap');
ta.setAttribute('spellcheck', 'false');
ta.setAttribute('autocomplete', 'off');
ta.setAttribute('autocapitalize', 'off');
ta.setAttribute('wrap', 'off');
ta.setAttribute('aria-label', 'Local file editor');
leftPane.append(leftBox, overlays.left);
rightPane.append(rightBox, overlays.right);
gutter.append(gBox);
main.append(leftPane, gutter, rightPane);
const noticeEl = el('div', 'notice');
app.append(bar, banner, heads, main, noticeEl, ta);

const btn = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
  const b = el('button', undefined, label);
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
};
const prevBtn = btn('▲ Prev', 'Previous change', () => goto(-1));
const nextBtn = btn('▼ Next', 'Next change', () => goto(1));
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
const openBtn = btn('Open in editor', 'Open the local file in a normal editor at the caret', () => data && vscode.postMessage({ type: 'openAt', side: data.editable ?? 'left', line: caret.line }));
const revBtn = btn('Revision…', 'Compare with another revision', () => vscode.postMessage({ type: 'pickRevision' }));
const refreshBtn = btn('Refresh', 'Re-read both sides', () => vscode.postMessage({ type: 'refresh' }));
const busyEl = el('span', 'busy', '');
const sendOptions = (): void =>
  vscode.postMessage({ type: 'options', ignoreWhitespace: wsSel.value as 'none' | 'trailing' | 'all', ignoreEol: eolCb.checked, ignoreCase: caseCb.checked });
wsSel.addEventListener('change', sendOptions);
caseCb.addEventListener('change', sendOptions);
eolCb.addEventListener('change', sendOptions);
bar.append(prevBtn, nextBtn, counter, pullAllBtn, openBtn, wsSel, lab(caseCb, 'Ignore case'), lab(eolCb, 'Ignore EOL'), revBtn, refreshBtn, busyEl);

function wordMap(ranges: { line: number; start: number; end: number }[]): Map<number, Range[]> {
  const m = new Map<number, Range[]>();
  for (const r of ranges) {
    const a = m.get(r.line) ?? [];
    a.push({ start: r.start, end: r.end });
    m.set(r.line, a);
  }
  return m;
}

function applyData(d: DataMessage): void {
  data = d;
  typing = d.typing ? d.editable : null;
  for (const w of ['left', 'right'] as const) {
    const s = sides[w];
    const info = d[w];
    s.lang = info.lang;
    if (info.lines) {
      blame[w] = undefined;
      s.lines = info.lines;
      s.html = highlight(info.lines, info.lang);
      s.virtual = false;
    }
    const wantVirtual = typing === w && info.endsWithEol;
    if (s.virtual !== wantVirtual) {
      if (wantVirtual) {
        s.lines.push('');
        s.html.push('');
      } else {
        s.lines.pop();
        s.html.pop();
      }
      s.virtual = wantVirtual;
    }
  }
  useTabs = typing ? sides[typing].lines.some((l) => l.startsWith('\t')) : false;
  sides.left.words = wordMap(d.hunks.flatMap((h) => h.words?.local ?? []));
  sides.right.words = wordMap(d.hunks.flatMap((h) => h.words?.incoming ?? []));
  rows = buildRows(d.blocks);
  if (typing && sides[typing].virtual) rows.push({ left: -1, right: -1, kind: 'equal', hunk: -1, first: false, [typing]: sides[typing].lines.length - 1 });
  reindex();
  if (d.caret) {
    caret = d.caret;
    anchor = null;
    want = -1;
  }
  if (typing) {
    caret = clampPos(sides[typing].lines, caret);
    if (anchor) anchor = clampPos(sides[typing].lines, anchor);
  } else anchor = null;
  leftPane.classList.toggle('edit', typing === 'left');
  rightPane.classList.toggle('edit', typing === 'right');
  openBtn.hidden = !d[d.editable ?? 'left'].openable;
  if (cur >= starts.length) cur = starts.length - 1;

  wsSel.value = d.options.ignoreWhitespace;
  eolCb.checked = d.options.ignoreEol;
  caseCb.checked = d.options.ignoreCase;
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

  maxLen = 1;
  for (const l of sides.left.lines) if (l.length > maxLen) maxLen = l.length;
  for (const l of sides.right.lines) if (l.length > maxLen) maxLen = l.length;
  layoutSizes();
  render(true);
}

function layoutSizes(): void {
  leftBox.style.minWidth = rightBox.style.minWidth = `${maxLen * charW + 80}px`;
  const h = rows.length * ROW_H;
  leftBox.style.minHeight = rightBox.style.minHeight = gBox.style.minHeight = `${h}px`;
}

function reindex(): void {
  starts = hunkRowStarts(rows);
  spans = hunkSpans(rows);
  lineRow = [];
  if (!typing) return;
  for (let i = 0; i < rows.length; i++) {
    const l = rows[i][typing];
    if (l >= 0 && lineRow[l] === undefined) lineRow[l] = i;
  }
}

function updateCounter(): void {
  counter.textContent = starts.length ? `${cur >= 0 ? cur + 1 : '-'} / ${starts.length} changes` : 'no changes';
}

let renderedFrom = -1;
let renderedTo = -1;
function render(force = false): void {
  if (!data) return;
  const viewH = leftPane.clientHeight || 600;
  const first = Math.max(0, Math.floor(leftPane.scrollTop / ROW_H) - BUFFER);
  const last = Math.min(rows.length, Math.ceil((leftPane.scrollTop + viewH) / ROW_H) + BUFFER);
  if (!force && first >= renderedFrom && last <= renderedTo && renderedFrom !== -1) return;
  renderedFrom = first;
  renderedTo = last;
  leftBox.replaceChildren(rowsHtml('left', first, last));
  rightBox.replaceChildren(rowsHtml('right', first, last));
  gBox.replaceChildren(gutterHtml(first, last));
  for (const b of [leftBox, rightBox]) b.style.paddingTop = `${first * ROW_H}px`;
  drawSelection();
}

function rowsHtml(side: 'left' | 'right', first: number, last: number): DocumentFragment {
  const frag = document.createDocumentFragment();
  const sv = sides[side];
  for (let i = first; i < last; i++) {
    const r = rows[i];
    const idx = side === 'left' ? r.left : r.right;
    const d = el('div');
    const classes = ['row'];
    if (idx < 0) {
      classes.push('filler');
    } else if (r.kind !== 'equal') {
      classes.push(side === 'left' ? 'del' : 'ins');
    }
    if (r.hunk >= 0 && r.hunk === cur) classes.push('cur');
    d.className = classes.join(' ');
    d.dataset.row = String(i);
    d.dataset.line = String(idx);
    d.dataset.side = side;
    if (idx >= 0) {
      const ln = el('span', 'ln', String(idx + 1));
      const tx = el('span', 'tx');
      const ranges = sv.words.get(idx);
      tx.innerHTML = ranges ? markWords(sv.html[idx] ?? '', ranges, side === 'left' ? 'w del' : 'w ins') : (sv.html[idx] ?? '');
      const hunk = r.hunk >= 0 ? data?.hunks[r.hunk] : undefined;
      const bl = blame[side];
      const au = hunk && bl && typing !== side ? (side === 'left' ? rowAuthorLabel(bl, hunk.localStart, hunk.localEnd, idx) : rowAuthorLabel(bl, hunk.incomingStart, hunk.incomingEnd, idx)) : undefined;
      if (au) {
        const a = el('span', 'au', au.text);
        a.title = au.title;
        d.append(ln, a, tx);
      } else d.append(ln, tx);
    } else {
      d.append(el('span', 'ln'), el('span', 'tx'));
    }
    frag.append(d);
  }
  return frag;
}

function connector(sp: HunkSpan): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const h = sp.count * ROW_H;
  const yl = sp.leftCount * ROW_H;
  const yr = sp.rightCount * ROW_H;
  const mid = GUTTER_W / 2;
  svg.setAttribute('class', 'conn' + (sp.hunk === cur ? ' cur' : ''));
  svg.setAttribute('width', String(GUTTER_W));
  svg.setAttribute('height', String(h));
  svg.style.top = `${sp.first * ROW_H}px`;
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', `M0 0 L${GUTTER_W} 0 L${GUTTER_W} ${yr} C${mid} ${yr} ${mid} ${yl} 0 ${yl} Z`);
  svg.append(path);
  return svg;
}

function gutterHtml(first: number, last: number): DocumentFragment {
  const frag = document.createDocumentFragment();
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (spans[m].first + spans[m].count <= first) lo = m + 1;
    else hi = m;
  }
  for (let k = lo; k < spans.length && spans[k].first < last; k++) {
    const sp = spans[k];
    frag.append(connector(sp));
    if (data?.editable) {
      const b = el('button', 'pull', data.editable === 'left' ? '←' : '→');
      b.dataset.hunk = String(sp.hunk);
      b.title = data.editable === 'left' ? 'Pull this change into the left (local) file' : 'Pull this change into the right (local) file';
      b.style.top = `${arrowTop(sp, ROW_H, BTN_H)}px`;
      b.style.left = `${(GUTTER_W - BTN_W) / 2}px`;
      frag.append(b);
    }
  }
  return frag;
}

function goto(dir: number): void {
  if (!starts.length) return;
  cur = cur < 0 ? (dir > 0 ? 0 : starts.length - 1) : (cur + dir + starts.length) % starts.length;
  const y = Math.max(0, starts[cur] * ROW_H - leftPane.clientHeight / 3);
  leftPane.scrollTop = y;
  rightPane.scrollTop = y;
  gutter.scrollTop = y;
  updateCounter();
  render(true);
}

let ticking = false;
function onScroll(from: HTMLElement): void {
  for (const o of [leftPane, rightPane, gutter]) {
    if (o !== from) {
      if (o.scrollTop !== from.scrollTop) o.scrollTop = from.scrollTop;
      if (o !== gutter && from !== gutter && o.scrollLeft !== from.scrollLeft) o.scrollLeft = from.scrollLeft;
    }
  }
  if (!ticking) {
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      render();
    });
  }
}
leftPane.addEventListener('scroll', () => onScroll(leftPane));
rightPane.addEventListener('scroll', () => onScroll(rightPane));
gutter.addEventListener('wheel', (e) => {
  leftPane.scrollTop += e.deltaY;
});
window.addEventListener('resize', () => render(true));

main.addEventListener('click', (e) => {
  const pull = (e.target as HTMLElement).closest('button.pull') as HTMLButtonElement | null;
  if (pull && data) {
    cur = Number(pull.dataset.hunk);
    vscode.postMessage({ type: 'pull', version: data.version, hunk: Number(pull.dataset.hunk) });
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'F7' || (e.altKey && e.key === 'ArrowDown')) goto(e.shiftKey ? -1 : 1);
  else if (e.altKey && e.key === 'ArrowUp') goto(-1);
});

// ---- editing of the local side: a hidden textarea captures input, the model is `sides[typing].lines` (one entry per document line) ----

const paneOf = (side: 'left' | 'right'): HTMLElement => (side === 'left' ? leftPane : rightPane);
const modelLines = (): string[] => (typing ? sides[typing].lines : []);
const hasSelection = (): boolean => !!anchor && comparePos(anchor, caret) !== 0;
const selection = (): { a: Pos; b: Pos } => {
  const a = hasSelection() && anchor ? anchor : caret;
  return comparePos(a, caret) <= 0 ? { a, b: caret } : { a: caret, b: a };
};

function highlightLine(side: SideView, text: string): string {
  return highlight([text], side.lang)[0] ?? '';
}

function shiftWords(m: Map<number, Range[]>, from: number, to: number, newCount: number): Map<number, Range[]> {
  const delta = newCount - (to - from + 1);
  const out = new Map<number, Range[]>();
  for (const [line, r] of m) {
    if (line < from) out.set(line, r);
    else if (line > to) out.set(line + delta, r);
  }
  return out;
}

function spliceArray<T>(arr: T[], start: number, count: number, items: T[]): void {
  if (items.length < 2000) {
    arr.splice(start, count, ...items);
    return;
  }
  const rest = arr.splice(start + count);
  arr.length = start;
  for (const i of items) arr.push(i);
  for (const r of rest) arr.push(r);
}

/** Applies an edit to the local model immediately and sends it to the extension. */
function edit(a: Pos, b: Pos, text: string): void {
  if (!typing) return;
  const side = sides[typing];
  const oldCount = b.line - a.line + 1;
  applyEditToLines(side.lines, a, b, text);
  const newCount = text.split('\n').length;
  const fresh: string[] = [];
  for (let i = 0; i < newCount; i++) {
    const t = side.lines[a.line + i] ?? '';
    if (t.length > maxLen) maxLen = t.length;
    fresh.push(highlightLine(side, t));
  }
  spliceArray(side.html, a.line, oldCount, fresh);
  side.words = shiftWords(side.words, a.line, b.line, newCount);
  if (newCount !== oldCount) {
    rows = shiftRows(rows, typing, a.line, b.line, newCount);
    reindex();
    layoutSizes();
  }
  caret = endPosition(a, text);
  anchor = null;
  want = -1;
  seq++;
  sentSeq = seq;
  vscode.postMessage({ type: 'edit', seq, start: a, end: b, text });
  updateCounter();
  render(true);
  ensureVisible();
}

function ensureVisible(): void {
  if (!typing) return;
  const row = lineRow[caret.line];
  if (row === undefined) return;
  const pane = paneOf(typing);
  const top = row * ROW_H;
  const viewH = pane.clientHeight - 18;
  if (top < pane.scrollTop) pane.scrollTop = top;
  else if (top + ROW_H > pane.scrollTop + viewH) pane.scrollTop = top + ROW_H - viewH;
  const x = TEXT_X + visualCol(modelLines()[caret.line] ?? '', caret.col) * charW;
  const viewW = pane.clientWidth - 18;
  if (x < pane.scrollLeft + TEXT_X + 4) pane.scrollLeft = Math.max(0, x - TEXT_X - 40);
  else if (x > pane.scrollLeft + viewW - 8) pane.scrollLeft = x - viewW + 60;
  drawSelection();
}

function drawSelection(): void {
  overlays.left.replaceChildren();
  overlays.right.replaceChildren();
  if (!typing) return;
  const lines = modelLines();
  const frag = document.createDocumentFragment();
  if (hasSelection()) {
    const { a, b } = selection();
    for (let i = Math.max(0, renderedFrom); i < renderedTo; i++) {
      const line = rows[i]?.[typing] ?? -1;
      if (line < a.line || line > b.line) continue;
      const t = lines[line] ?? '';
      const v1 = line === a.line ? visualCol(t, a.col) : 0;
      const v2 = line === b.line ? visualCol(t, b.col) : visualCol(t, t.length) + 1;
      if (v2 <= v1) continue;
      const r = el('div', 'selrect' + (focused ? '' : ' idle'));
      r.style.top = `${i * ROW_H}px`;
      r.style.left = `${TEXT_X + v1 * charW}px`;
      r.style.width = `${(v2 - v1) * charW}px`;
      frag.append(r);
    }
  }
  const row = lineRow[caret.line];
  if (focused && row !== undefined && row >= renderedFrom && row < renderedTo) {
    const c = el('div', 'caret');
    c.style.top = `${row * ROW_H}px`;
    c.style.left = `${TEXT_X + visualCol(lines[caret.line] ?? '', caret.col) * charW - 1}px`;
    frag.append(c);
  }
  overlays[typing].append(frag);
}

function moveCaret(to: Pos, extend: boolean, keepWant = false): void {
  if (extend) anchor ??= { ...caret };
  else anchor = null;
  caret = to;
  if (!keepWant) want = -1;
  ensureVisible();
}

const docEnd = (): Pos => {
  const l = modelLines();
  return { line: l.length - 1, col: (l[l.length - 1] ?? '').length };
};

function deleteSelection(): boolean {
  if (!hasSelection()) return false;
  const { a, b } = selection();
  edit(a, b, '');
  return true;
}

function insertText(text: string): void {
  if (!typing || !text) return;
  const { a, b } = selection();
  edit(a, b, text);
}

function onKey(e: KeyboardEvent): void {
  if (!typing || composing) return;
  const lines = modelLines();
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key;
  const text = lines[caret.line] ?? '';
  const handled = (): void => e.preventDefault();

  if (ctrl && !e.altKey) {
    const k = key.toLowerCase();
    if (k === 'z' || k === 'y') {
      handled();
      post(k === 'y' || e.shiftKey ? 'redo' : 'undo');
      return;
    }
    if (k === 's') {
      handled();
      vscode.postMessage({ type: 'save' });
      return;
    }
    if (k === 'a') {
      handled();
      anchor = { line: 0, col: 0 };
      caret = docEnd();
      drawSelection();
      return;
    }
    if (k === 'c' || k === 'x' || k === 'v') return; // clipboard events do the work
  }
  if (e.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) return;
  if (key === 'F7') return;

  switch (key) {
    case 'ArrowLeft': {
      handled();
      if (!e.shiftKey && hasSelection()) return moveCaret(selection().a, false);
      if (caret.col === 0) return caret.line > 0 ? moveCaret({ line: caret.line - 1, col: lines[caret.line - 1].length }, e.shiftKey) : undefined;
      return moveCaret({ line: caret.line, col: ctrl ? wordLeft(text, caret.col) : caret.col - 1 }, e.shiftKey);
    }
    case 'ArrowRight': {
      handled();
      if (!e.shiftKey && hasSelection()) return moveCaret(selection().b, false);
      if (caret.col >= text.length) return caret.line < lines.length - 1 ? moveCaret({ line: caret.line + 1, col: 0 }, e.shiftKey) : undefined;
      return moveCaret({ line: caret.line, col: ctrl ? wordRight(text, caret.col) : caret.col + 1 }, e.shiftKey);
    }
    case 'ArrowUp':
    case 'ArrowDown':
    case 'PageUp':
    case 'PageDown': {
      handled();
      const page = Math.max(1, Math.floor(paneOf(typing).clientHeight / ROW_H) - 1);
      const step = key === 'PageUp' ? -page : key === 'PageDown' ? page : key === 'ArrowUp' ? -1 : 1;
      const line = Math.max(0, Math.min(lines.length - 1, caret.line + step));
      if (want < 0) want = visualCol(text, caret.col);
      if (line === caret.line) return moveCaret(step < 0 ? { line, col: 0 } : { line, col: text.length }, e.shiftKey);
      return moveCaret({ line, col: colAtVisual(lines[line], want) }, e.shiftKey, true);
    }
    case 'Home': {
      handled();
      if (ctrl) return moveCaret({ line: 0, col: 0 }, e.shiftKey);
      const indent = leadingWhitespace(text).length;
      return moveCaret({ line: caret.line, col: caret.col === indent ? 0 : indent }, e.shiftKey);
    }
    case 'End':
      handled();
      return moveCaret(ctrl ? docEnd() : { line: caret.line, col: text.length }, e.shiftKey);
    case 'Backspace': {
      handled();
      if (deleteSelection()) return;
      if (caret.col > 0) return edit({ line: caret.line, col: ctrl ? wordLeft(text, caret.col) : caret.col - 1 }, caret, '');
      if (caret.line > 0) return edit({ line: caret.line - 1, col: lines[caret.line - 1].length }, caret, '');
      return;
    }
    case 'Delete': {
      handled();
      if (deleteSelection()) return;
      if (caret.col < text.length) return edit(caret, { line: caret.line, col: ctrl ? wordRight(text, caret.col) : caret.col + 1 }, '');
      if (caret.line < lines.length - 1) return edit(caret, { line: caret.line + 1, col: 0 }, '');
      return;
    }
    case 'Enter': {
      handled();
      const { a } = selection();
      const indent = leadingWhitespace(lines[a.line] ?? '').slice(0, a.col);
      return insertText('\n' + indent);
    }
    case 'Tab': {
      handled();
      const unit = useTabs ? '\t' : '    ';
      const { a, b } = selection();
      if (e.shiftKey || a.line !== b.line) {
        const last = b.line > a.line && b.col === 0 ? b.line - 1 : b.line;
        const start = { line: a.line, col: 0 };
        const end = { line: last, col: (lines[last] ?? '').length };
        const next = reindent(lines, a.line, last, e.shiftKey, unit);
        if (next === textInRange(lines, start, end)) return;
        edit(start, end, next);
        anchor = { line: a.line, col: 0 };
        caret = endPosition(start, next);
        drawSelection();
        return;
      }
      return insertText(useTabs ? '\t' : ' '.repeat(4 - (visualCol(text, a.col) % 4)));
    }
    case 'Escape':
      anchor = null;
      drawSelection();
      return;
  }
}

function post(kind: 'undo' | 'redo'): void {
  seq++;
  sentSeq = seq;
  vscode.postMessage({ type: kind, seq });
}

function lineRangeAtCaret(): { a: Pos; b: Pos } {
  const lines = modelLines();
  const n = caret.line;
  if (n < lines.length - 1) return { a: { line: n, col: 0 }, b: { line: n + 1, col: 0 } };
  if (n > 0) return { a: { line: n - 1, col: lines[n - 1].length }, b: { line: n, col: lines[n].length } };
  return { a: { line: 0, col: 0 }, b: { line: 0, col: (lines[0] ?? '').length } };
}

function copyText(): string {
  const lines = modelLines();
  if (hasSelection()) {
    const { a, b } = selection();
    return textInRange(lines, a, b);
  }
  return (lines[caret.line] ?? '') + '\n';
}

ta.addEventListener('keydown', onKey);
ta.addEventListener('copy', (e) => {
  if (!typing) return;
  e.preventDefault();
  e.clipboardData?.setData('text/plain', copyText());
});
ta.addEventListener('cut', (e) => {
  if (!typing) return;
  e.preventDefault();
  e.clipboardData?.setData('text/plain', copyText());
  if (!deleteSelection()) {
    const { a, b } = lineRangeAtCaret();
    edit(a, b, '');
  }
});
ta.addEventListener('paste', (e) => {
  if (!typing) return;
  e.preventDefault();
  insertText((e.clipboardData?.getData('text/plain') ?? '').replace(/\r\n?/g, '\n'));
});
ta.addEventListener('input', () => {
  if (composing) return;
  const v = ta.value;
  ta.value = '';
  insertText(v.replace(/\r\n?/g, '\n'));
});
ta.addEventListener('compositionstart', () => {
  composing = true;
});
ta.addEventListener('compositionend', () => {
  composing = false;
  const v = ta.value;
  ta.value = '';
  insertText(v);
});
ta.addEventListener('focus', () => {
  focused = true;
  drawSelection();
});
ta.addEventListener('blur', () => {
  focused = false;
  drawSelection();
});

function posAt(e: MouseEvent): Pos {
  const side = typing as 'left' | 'right';
  const pane = paneOf(side);
  const r = pane.getBoundingClientRect();
  const lines = modelLines();
  const y = e.clientY - r.top + pane.scrollTop;
  const row = Math.max(0, Math.min(rows.length - 1, Math.floor(y / ROW_H)));
  const line = rows[row]?.[side] ?? -1;
  if (line < 0) {
    for (let k = row; k < rows.length; k++) if (rows[k][side] >= 0) return { line: rows[k][side], col: 0 };
    return docEnd();
  }
  const x = e.clientX - r.left + pane.scrollLeft - TEXT_X;
  return { line, col: x <= 0 ? 0 : colAtVisual(lines[line] ?? '', x / charW) };
}

function onMouseDown(e: MouseEvent): void {
  if (!typing || e.button !== 0) return;
  const pane = paneOf(typing);
  const r = pane.getBoundingClientRect();
  if (e.clientX - r.left >= pane.clientWidth || e.clientY - r.top >= pane.clientHeight) return;
  e.preventDefault();
  ta.focus({ preventScroll: true });
  const p = posAt(e);
  const lines = modelLines();
  want = -1;
  if (e.detail === 2) {
    const [s, en] = wordAt(lines[p.line] ?? '', p.col);
    anchor = { line: p.line, col: s };
    caret = { line: p.line, col: en };
  } else if (e.detail >= 3) {
    anchor = { line: p.line, col: 0 };
    caret = p.line < lines.length - 1 ? { line: p.line + 1, col: 0 } : { line: p.line, col: (lines[p.line] ?? '').length };
  } else {
    if (e.shiftKey) anchor ??= { ...caret };
    else anchor = p;
    caret = p;
    dragging = true;
  }
  drawSelection();
}
leftPane.addEventListener('mousedown', (e) => typing === 'left' && onMouseDown(e));
rightPane.addEventListener('mousedown', (e) => typing === 'right' && onMouseDown(e));
document.addEventListener('mousemove', (e) => {
  if (!dragging || !typing) return;
  const pane = paneOf(typing);
  const r = pane.getBoundingClientRect();
  if (e.clientY < r.top) pane.scrollTop -= ROW_H;
  else if (e.clientY > r.bottom) pane.scrollTop += ROW_H;
  caret = posAt(e);
  drawSelection();
});
document.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  if (anchor && comparePos(anchor, caret) === 0) anchor = null;
  drawSelection();
});

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const m = e.data;
  if (m.type === 'busy') {
    busyEl.textContent = m.busy ? 'Loading…' : '';
    return;
  }
  if (m.type === 'blame') {
    blame[m.side] = m.blame;
    render(true);
    return;
  }
  if (m.ackSeq < sentSeq) return;
  applyData(m);
});

{
  const probe = el('span', 'probe', 'MMMMMMMMMM');
  document.body.append(probe);
  charW = probe.getBoundingClientRect().width / 10 || 8;
  probe.remove();
}
vscode.postMessage({ type: 'ready' });

import { el, highlight } from '../../compare/webview/shared';
import { hiddenDifferenceBadge } from '../../diff/hidden';
import type { Choice, ConflictSegment, Segment, Side } from '../merge';
import { segmentSources } from '../merge';
import type { ConflictData, FromWebview, ToWebview } from '../protocol';

interface VsCodeApi {
  postMessage(m: FromWebview): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

const CONTEXT = 3;
const sides: Record<Side, { lines: string[]; html: string[] }> = {
  base: { lines: [], html: [] },
  mine: { lines: [], html: [] },
  theirs: { lines: [], html: [] },
};
let data: ConflictData | undefined;
let cur = -1;
const expanded = new Set<number>();

const app = document.getElementById('app') as HTMLElement;
const bar = el('div', 'toolbar');
const banner = el('div', 'banner');
const notes = el('pre', 'notes');
const heads = el('div', 'cheads');
const headEls = { mine: el('div', 'head'), result: el('div', 'head'), theirs: el('div', 'head') };
heads.append(headEls.mine, headEls.result, headEls.theirs);
const scroller = el('div', 'cmain');
const noticeEl = el('div', 'notice');
app.append(bar, banner, notes, heads, scroller, noticeEl);

const btn = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
  const b = el('button', undefined, label);
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
};
const post = (m: FromWebview): void => vscode.postMessage(m);
const prevBtn = btn('▲ Prev', 'Previous conflict (Alt+Up)', () => goto(-1));
const nextBtn = btn('▼ Next', 'Next conflict (F7 / Alt+Down)', () => goto(1));
const counter = el('span', 'counter');
const allMine = btn('All mine', 'Take mine in every open conflict', () => data && post({ type: 'chooseAll', version: data.version, choice: 'mine' }));
const allTheirs = btn('All theirs', 'Take theirs in every open conflict', () => data && post({ type: 'chooseAll', version: data.version, choice: 'theirs' }));
const saveBtn = btn('Save', 'Write the result', () => data && post({ type: 'save', version: data.version }));
const resolveBtn = btn('Save and mark resolved', '', () => data && post({ type: 'saveResolve', version: data.version }));
resolveBtn.classList.add('primary');
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
const openBtn = btn('Open file', 'Open the working file in the editor', () => post({ type: 'openFile' }));
const refreshBtn = btn('Reload', 'Re-read the three inputs and start over', () => post({ type: 'refresh' }));
const busyEl = el('span', 'busy', '');
const sendOptions = (): void => post({ type: 'options', ignoreWhitespace: wsSel.value as 'none' | 'trailing' | 'all', ignoreEol: eolCb.checked, ignoreCase: caseCb.checked });
wsSel.addEventListener('change', sendOptions);
caseCb.addEventListener('change', sendOptions);
eolCb.addEventListener('change', sendOptions);
bar.append(prevBtn, nextBtn, counter, allMine, allTheirs, saveBtn, resolveBtn, wsSel, lab(caseCb, 'Ignore case'), lab(eolCb, 'Ignore EOL'), openBtn, refreshBtn, busyEl);

const choiceButtons: Array<[Choice, string, string]> = [
  ['mine-theirs', 'Mine + Theirs', 'Both: mine first, then theirs'],
  ['theirs-mine', 'Theirs + Mine', 'Both: theirs first, then mine'],
  ['base', 'Base', 'Neither: use the common ancestor'],
];

function rowEl(side: Side, idx: number, cls: string, no: number | string): HTMLElement {
  const d = el('div', `row ${cls}`);
  const ln = el('span', 'ln', String(no));
  const tx = el('span', 'tx');
  tx.innerHTML = sides[side].html[idx] ?? '';
  d.append(ln, tx);
  return d;
}

function fillerRows(n: number, cls: string): HTMLElement[] {
  return Array.from({ length: n }, () => {
    const d = el('div', `row filler ${cls}`);
    d.append(el('span', 'ln'), el('span', 'tx'));
    return d;
  });
}

function sideRows(side: 'mine' | 'theirs', seg: Segment, cls: string, from = seg[side].start, to = seg[side].end): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (let i = from; i < to; i++) rows.push(rowEl(side, i, cls, i + 1));
  return rows;
}

function cell(extra: string, ...kids: Array<HTMLElement | HTMLElement[]>): HTMLElement {
  const c = el('div', `cell ${extra}`);
  for (const k of kids) c.append(...(Array.isArray(k) ? k : [k]));
  return c;
}

let resultNo = 1;
function resultRows(seg: Segment, choice: Choice | undefined, cls: string): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const s of segmentSources(seg, choice)) {
    for (let i = s.range.start; i < s.range.end; i++) rows.push(rowEl(s.side, i, cls, resultNo++));
  }
  return rows;
}

function head(title: string, ...buttons: HTMLButtonElement[]): HTMLElement {
  const h = el('div', 'chead');
  h.append(el('span', 'ctitle', title), ...buttons);
  return h;
}

function conflictBlock(seg: ConflictSegment, d: ConflictData): HTMLElement {
  const choice = d.choices[seg.index];
  const act = (c: Choice, label: string, title: string): HTMLButtonElement => {
    const b = btn(label, title, () => post({ type: 'choose', version: d.version, conflict: seg.index, choice: c }));
    if (choice === c) b.classList.add('on');
    return b;
  };
  const row = el('div', 'seg conflict' + (choice ? ' done' : ' open') + (seg.index === cur ? ' cur' : ''));
  row.dataset.conflict = String(seg.index);
  const mine = cell('c-mine', head(`Conflict ${seg.index + 1}: mine`, act('mine', 'Take mine', 'Use my side')), sideRows('mine', seg, 'cf-mine'));
  const theirs = cell('c-theirs', head('theirs', act('theirs', 'Take theirs', 'Use the incoming side')), sideRows('theirs', seg, 'cf-theirs'));
  const bothButtons = choiceButtons.map(([c, l, t]) => act(c, l, t));
  const editBtn = btn('Edit', 'Edit the result by hand', () => post({ type: 'edit', version: d.version, conflict: seg.index }));
  if (choice === 'custom') editBtn.classList.add('on');
  const resHead = head(choice ? (choice === 'custom' ? 'result: edited' : `result: ${choice}`) : 'result: unresolved', ...bothButtons, editBtn);
  let body: HTMLElement[];
  if (choice === 'custom') {
    const ta = el('textarea', 'edit');
    ta.spellcheck = false;
    ta.value = d.customs[seg.index] ?? '';
    const fit = (): void => {
      ta.rows = Math.max(2, ta.value.split('\n').length + 1);
    };
    fit();
    ta.addEventListener('input', () => {
      fit();
      post({ type: 'custom', version: d.version, conflict: seg.index, text: ta.value });
    });
    resultNo += Math.max(1, ta.value.split('\n').length - (ta.value.endsWith('\n') ? 1 : 0));
    body = [ta];
  } else if (choice) {
    body = resultRows(seg, choice, 'cf-done');
  } else {
    const n = Math.max(seg.mine.end - seg.mine.start, seg.theirs.end - seg.theirs.start, 1);
    const ph = fillerRows(n, 'cf-open');
    ph[0].querySelector('.tx')!.textContent = 'Unresolved: choose mine, theirs, both, or edit';
    body = ph;
  }
  row.append(mine, cell('c-result', resHead, body), theirs);
  return row;
}

function seg3(kind: string, mine: HTMLElement[], result: HTMLElement[], theirs: HTMLElement[]): HTMLElement {
  const row = el('div', `seg ${kind}`);
  row.append(cell('c-mine', mine), cell('c-result', result), cell('c-theirs', theirs));
  return row;
}

function render(d: ConflictData): void {
  const keep = scroller.scrollTop;
  resultNo = 1;
  const frag = document.createDocumentFragment();
  d.segments.forEach((seg, i) => {
    if (seg.kind === 'conflict') {
      frag.append(conflictBlock(seg, d));
      return;
    }
    if (seg.kind === 'auto') {
      const fromM = seg.from !== 'theirs';
      const fromT = seg.from !== 'mine';
      const tag = seg.from === 'both' ? 'auto-merged (same on both sides)' : `auto-merged from ${seg.from}`;
      const spacer = (): HTMLElement => el('div', 'chead spacer');
      const row = seg3(
        'auto',
        [spacer(), ...sideRows('mine', seg, fromM ? 'ch-mine' : '')],
        [head(tag), ...resultRows(seg, undefined, 'ch-auto')],
        [spacer(), ...sideRows('theirs', seg, fromT ? 'ch-theirs' : '')],
      );
      frag.append(row);
      return;
    }
    const n = seg.mine.end - seg.mine.start;
    const top = i > 0 ? CONTEXT : 0;
    const bot = i < d.segments.length - 1 ? CONTEXT : 0;
    if (expanded.has(i) || n <= top + bot + 2) {
      frag.append(seg3('stable', sideRows('mine', seg, ''), resultRows(seg, undefined, ''), sideRows('theirs', seg, '')));
      return;
    }
    const part = (from: number, to: number): HTMLElement => {
      const m = { ...seg, mine: { start: seg.mine.start + from, end: seg.mine.start + to } };
      const t = { ...seg, theirs: { start: seg.theirs.start + from, end: seg.theirs.start + to } };
      const res: HTMLElement[] = [];
      for (let k = from; k < to; k++) res.push(rowEl('mine', seg.mine.start + k, '', resultNo + k - from));
      return seg3('stable', sideRows('mine', m, ''), res, sideRows('theirs', t, ''));
    };
    if (top) frag.append(part(0, top));
    resultNo += top;
    const fold = el('div', 'fold', `⋯ ${n - top - bot} unchanged lines (click to expand)`);
    fold.addEventListener('click', () => {
      expanded.add(i);
      if (data) render(data);
    });
    frag.append(fold);
    resultNo += n - top - bot;
    if (bot) frag.append(part(n - bot, n));
    resultNo += bot;
  });
  scroller.replaceChildren(frag);
  scroller.scrollTop = keep;
}

function conflictEls(): HTMLElement[] {
  return [...scroller.querySelectorAll<HTMLElement>('.seg.conflict')];
}

function goto(dir: number): void {
  const list = conflictEls();
  if (!list.length) return;
  const open = list.map((e, i) => (e.classList.contains('open') ? i : -1)).filter((i) => i >= 0);
  const pool = open.length ? open : list.map((_, i) => i);
  const next = dir > 0 ? (pool.find((i) => i > cur) ?? pool[0]) : ([...pool].reverse().find((i) => i < cur) ?? pool[pool.length - 1]);
  cur = next;
  list.forEach((e, i) => e.classList.toggle('cur', i === cur));
  list[cur].scrollIntoView({ block: 'center' });
  updateCounter();
}

function updateCounter(): void {
  if (!data) return;
  const total = data.choices.length;
  counter.textContent = total ? `${data.unresolved} unresolved / ${total} conflicts` : 'no conflicts';
}

function applyData(d: ConflictData): void {
  data = d;
  noticeEl.hidden = true;
  for (const w of ['base', 'mine', 'theirs'] as const) {
    const info = d[w];
    if (info.lines) {
      sides[w].lines = info.lines;
      sides[w].html = highlight(info.lines, d.lang);
    }
  }
  wsSel.value = d.options.ignoreWhitespace;
  eolCb.checked = d.options.ignoreEol;
  caseCb.checked = d.options.ignoreCase;
  const hiddenBadge = hiddenDifferenceBadge(d.options, 'merge');
  const msgs: string[] = [];
  if (hiddenBadge) msgs.push(hiddenBadge);
  if (d.saved) msgs.push('Result saved; not marked resolved yet.');
  banner.textContent = msgs.join('  ·  ');
  banner.className = 'banner' + (hiddenBadge ? ' warn' : '');
  banner.hidden = !banner.textContent;
  notes.textContent = d.notes ?? '';
  notes.hidden = !d.notes;
  headEls.mine.textContent = `${d.mine.label}  ·  ${d.mine.lineCount} lines`;
  headEls.theirs.textContent = `${d.theirs.label}  ·  ${d.theirs.lineCount} lines`;
  headEls.result.textContent = `Result  ·  ${d.name}  ·  ${d.encoding}`;
  saveBtn.textContent = d.applyLabel;
  resolveBtn.textContent = d.resolveLabel;
  resolveBtn.title = 'Write the result and mark the conflict resolved in svn';
  const open = d.unresolved > 0;
  saveBtn.disabled = resolveBtn.disabled = open;
  allMine.disabled = allTheirs.disabled = !open;
  prevBtn.disabled = nextBtn.disabled = !d.choices.length;
  if (cur >= d.choices.length) cur = -1;
  updateCounter();
  render(d);
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLTextAreaElement) return;
  if (e.key === 'F7' || (e.altKey && e.key === 'ArrowDown')) goto(e.shiftKey ? -1 : 1);
  else if (e.altKey && e.key === 'ArrowUp') goto(-1);
});

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const m = e.data;
  if (m.type === 'busy') busyEl.textContent = m.busy ? 'Loading…' : '';
  else if (m.type === 'notice') {
    noticeEl.textContent = m.text;
    noticeEl.hidden = false;
  } else applyData(m);
});

noticeEl.hidden = true;
post({ type: 'ready' });

(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const GLYPH = { modified: 'M', added: 'A', deleted: 'D', replaced: 'R', unversioned: '?', conflicted: 'C', missing: '!', normal: 'P', obstructed: '~', incomplete: '~' };

  let state = { repos: [], history: [] };
  const checked = new Set();
  let busy = false;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  function allEntries() {
    return state.repos.flatMap((r) => r.entries);
  }

  function setBusy(on, text) {
    busy = on;
    $('commit').disabled = on;
    $('status').textContent = on ? text || 'Working...' : '';
    ['refresh', 'checkAll', 'uncheckAll', 'history', 'keepLocks', 'keepChangelists'].forEach((id) => {
      $(id).disabled = on || (id === 'history' && !state.history.length);
    });
    $('message').readOnly = on;
  }

  function updateCount() {
    const n = allEntries().filter((e) => checked.has(e.path) && e.kind !== 'blocked').length;
    $('count').textContent = n + ' of ' + allEntries().filter((e) => e.kind !== 'blocked').length + ' selected';
  }

  function checkbox(isChecked, disabled, onChange) {
    const c = el('input');
    c.type = 'checkbox';
    c.checked = isChecked;
    c.disabled = !!disabled;
    c.addEventListener('change', () => onChange(c.checked));
    return c;
  }

  function setMany(entries, on) {
    for (const e of entries) {
      if (e.kind === 'blocked') continue;
      if (on) checked.add(e.path);
      else checked.delete(e.path);
    }
    render();
  }

  function renderRow(repo, e) {
    const row = el('div', 'row' + (e.kind === 'blocked' ? ' blocked' : ''));
    row.title = e.reason || e.path;
    row.appendChild(checkbox(checked.has(e.path), e.kind === 'blocked', (v) => {
      if (v) checked.add(e.path);
      else checked.delete(e.path);
      updateCount();
    }));
    const badge = el('span', 'badge s-' + e.item, GLYPH[e.item] || '?');
    row.appendChild(badge);
    const p = el('span', 'path');
    const slash = e.rel.lastIndexOf('/');
    p.appendChild(el('span', 'name', slash >= 0 ? e.rel.slice(slash + 1) : e.rel));
    if (slash >= 0) p.appendChild(el('span', 'dir', e.rel.slice(0, slash)));
    if (e.item === 'normal') p.appendChild(el('span', 'dir', '(properties)'));
    if (e.locked) p.appendChild(el('span', 'dir', 'locked'));
    row.appendChild(p);
    if (!e.isDir && e.item !== 'conflicted') {
      const b = el('button', 'link', e.item === 'unversioned' || e.item === 'added' ? 'Open' : 'Show changes');
      b.addEventListener('click', () => vscode.postMessage({ type: 'showChanges', repo: repo.name, path: e.path }));
      row.appendChild(b);
    }
    return row;
  }

  function render() {
    const root = $('files');
    root.textContent = '';
    if (!state.repos.length || !allEntries().length) root.appendChild(el('div', 'empty', 'No outgoing changes.'));
    for (const repo of state.repos) {
      const head = el('div', 'repo');
      const selectable = repo.entries.filter((e) => e.kind !== 'blocked');
      head.appendChild(checkbox(selectable.length > 0 && selectable.every((e) => checked.has(e.path)), !selectable.length, (v) => setMany(repo.entries, v)));
      head.appendChild(el('span', '', repo.name + ' (' + repo.entries.length + ')'));
      root.appendChild(head);
      const groups = new Map();
      for (const e of repo.entries) {
        const k = e.changelist || '';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(e);
      }
      const keys = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
      const showGroups = keys.length > 1 || (keys.length === 1 && keys[0] !== '');
      for (const k of keys) {
        const list = groups.get(k);
        if (showGroups) {
          const g = el('div', 'group');
          const sel = list.filter((e) => e.kind !== 'blocked');
          g.appendChild(checkbox(sel.length > 0 && sel.every((e) => checked.has(e.path)), !sel.length, (v) => setMany(list, v)));
          g.appendChild(el('span', '', k === '' ? 'Changes' : 'Changelist: ' + k));
          root.appendChild(g);
        }
        for (const e of list) root.appendChild(renderRow(repo, e));
      }
    }
    updateCount();
  }

  function renderHistory() {
    const sel = $('history');
    sel.textContent = '';
    const first = el('option', '', state.history.length ? 'Recent messages...' : 'No previous messages');
    first.value = '';
    sel.appendChild(first);
    state.history.forEach((m, i) => {
      const o = el('option', '', m.replace(/\s+/g, ' ').slice(0, 90));
      o.value = String(i);
      o.title = m;
      sel.appendChild(o);
    });
    sel.disabled = !state.history.length;
  }

  $('history').addEventListener('change', (ev) => {
    const i = ev.target.value;
    if (i !== '') $('message').value = state.history[Number(i)];
    ev.target.value = '';
    $('message').focus();
  });
  $('checkAll').addEventListener('click', () => setMany(allEntries(), true));
  $('uncheckAll').addEventListener('click', () => setMany(allEntries(), false));
  $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh', selected: [...checked], message: $('message').value }));
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  $('commit').addEventListener('click', () => {
    $('error').textContent = '';
    const message = $('message').value;
    const selected = allEntries().filter((e) => checked.has(e.path) && e.kind !== 'blocked').map((e) => e.path);
    if (!selected.length) {
      $('error').textContent = 'Select at least one file to commit.';
      return;
    }
    vscode.postMessage({ type: 'commit', message, selected, keepLocks: $('keepLocks').checked, keepChangelists: $('keepChangelists').checked });
  });
  $('message').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) $('commit').click();
  });

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'init') {
      state = { repos: m.repos, history: m.history || [] };
      checked.clear();
      m.checked.forEach((p) => checked.add(p));
      if (typeof m.message === 'string') $('message').value = m.message;
      $('title').textContent = m.title || 'Commit';
      $('keepLocks').checked = !!m.keepLocks;
      $('keepChangelists').checked = !!m.keepChangelists;
      renderHistory();
      render();
      setBusy(false);
      $('error').textContent = m.error || '';
    } else if (m.type === 'busy') {
      setBusy(m.on, m.text);
    } else if (m.type === 'error') {
      setBusy(false);
      $('error').textContent = m.text;
    }
  });
  vscode.postMessage({ type: 'ready' });
})();

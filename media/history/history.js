/* SVN history view. All dynamic text goes through textContent (commit messages are untrusted). */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const open = new Set();
  let entries = [];
  let hasMore = false;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  const title = el('h1', '', 'SVN History');
  const sub = el('div', 'sub');
  const form = el('form', 'filters');
  const fields = {};
  function field(key, label, type, placeholder) {
    const l = el('label');
    l.appendChild(el('span', '', label));
    const i = document.createElement('input');
    i.type = type;
    if (placeholder) i.placeholder = placeholder;
    l.appendChild(i);
    form.appendChild(l);
    fields[key] = i;
  }
  field('author', 'Author', 'text');
  field('text', 'Message contains', 'text');
  field('path', 'Path contains', 'text');
  field('dateFrom', 'From date', 'date');
  field('dateTo', 'To date', 'date');
  field('revFrom', 'From revision', 'number');
  field('revTo', 'To revision', 'number');
  const stopLabel = el('label', 'check');
  const stop = document.createElement('input');
  stop.type = 'checkbox';
  stopLabel.appendChild(stop);
  stopLabel.appendChild(el('span', '', 'Stop on copy'));
  form.appendChild(stopLabel);
  const apply = el('button', '', 'Apply');
  apply.type = 'submit';
  const clear = el('button', 'secondary', 'Clear');
  clear.type = 'button';
  const btns = el('div');
  btns.append(apply, ' ', clear);
  form.appendChild(btns);

  const err = el('div', 'error');
  const status = el('div', 'status');
  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['Revision', 'Message', 'Author', 'Date', 'Paths']) hr.appendChild(el('th', '', h));
  thead.appendChild(hr);
  const tbody = el('tbody');
  table.append(thead, tbody);
  const more = el('button', 'secondary', 'Load more');
  more.hidden = true;
  app.append(title, sub, form, err, status, table, more);

  function readFilter() {
    const f = {};
    for (const k of ['author', 'text', 'path']) if (fields[k].value.trim()) f[k] = fields[k].value.trim();
    for (const k of ['dateFrom', 'dateTo']) if (fields[k].value) f[k] = fields[k].value;
    for (const k of ['revFrom', 'revTo']) if (fields[k].value !== '') f[k] = Number(fields[k].value);
    if (stop.checked) f.stopOnCopy = true;
    return f;
  }

  function load(isMore) {
    err.textContent = '';
    vscode.postMessage({ type: 'load', filter: readFilter(), more: isMore });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    open.clear();
    load(false);
  });
  clear.addEventListener('click', () => {
    for (const k of Object.keys(fields)) fields[k].value = '';
    stop.checked = false;
    open.clear();
    load(false);
  });
  more.addEventListener('click', () => load(true));

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  function actionButton(label, type, rev, cls) {
    const b = el('button', cls || 'small secondary', label);
    b.type = 'button';
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      vscode.postMessage({ type, rev });
    });
    return b;
  }

  let targetIsUrl = false;

  function detailRow(e) {
    const tr = el('tr', 'detail');
    const td = el('td');
    td.colSpan = 5;
    td.appendChild(el('pre', 'fullmsg', e.message || '(no message)'));
    const actions = el('div', 'actions');
    // Working-copy actions only make sense when the history target is a local path, not a repository URL.
    if (!targetIsUrl) {
      actions.append(
        actionButton('Update to this revision', 'update', e.revision),
        actionButton('Revert changes of this revision', 'revertChanges', e.revision),
        actionButton('Revert to this revision', 'revertTo', e.revision),
      );
    }
    actions.append(
      actionButton('Merge this revision into working copy', 'merge', e.revision),
      actionButton('Copy revision number', 'copy', e.revision),
      actionButton('Show full message', 'message', e.revision),
    );
    td.appendChild(actions);
    const ul = el('ul', 'paths');
    for (const p of e.paths) {
      const li = el('li');
      li.appendChild(el('span', 'act act-' + p.action, p.action));
      if (p.kind === 'dir') {
        li.appendChild(el('span', 'dim', p.path + '/'));
      } else {
        const a = el('a', 'pathlink', p.path);
        a.title = 'Show diff (before and after this revision)';
        a.addEventListener('click', () => vscode.postMessage({ type: 'diff', rev: e.revision, path: p.path }));
        li.appendChild(a);
      }
      if (p.copyfromPath) li.appendChild(el('span', 'dim', '(from ' + p.copyfromPath + '@' + p.copyfromRev + ')'));
      ul.appendChild(li);
    }
    td.appendChild(ul);
    tr.appendChild(td);
    return tr;
  }

  function render() {
    tbody.textContent = '';
    for (const e of entries) {
      const tr = el('tr', 'row' + (open.has(e.revision) ? ' open' : ''));
      tr.appendChild(el('td', 'rev', 'r' + e.revision));
      tr.appendChild(el('td', 'msg', (e.message || '').split(/\r?\n/)[0]));
      tr.appendChild(el('td', '', e.author || ''));
      tr.appendChild(el('td', 'when', fmtDate(e.date)));
      tr.appendChild(el('td', '', String(e.paths.length)));
      tr.addEventListener('click', () => {
        if (open.has(e.revision)) open.delete(e.revision);
        else open.add(e.revision);
        render();
      });
      tbody.appendChild(tr);
      if (open.has(e.revision)) tbody.appendChild(detailRow(e));
    }
    more.hidden = !hasMore;
    status.textContent = entries.length ? entries.length + ' revision(s) shown' + (hasMore ? ', more available' : ', end of history') : '';
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'init') {
      targetIsUrl = !!m.isUrl;
      sub.textContent = m.repo + ': ' + m.name;
    } else if (m.type === 'loading') {
      status.textContent = 'Loading...';
      more.disabled = true;
    } else if (m.type === 'page') {
      more.disabled = false;
      if (m.error) err.textContent = m.error;
      entries = m.append ? entries.concat(m.entries) : m.entries;
      hasMore = !!m.hasMore;
      render();
      if (!m.error && !entries.length) status.textContent = 'No revisions match.';
    }
  });

  vscode.postMessage({ type: 'ready' });
})();

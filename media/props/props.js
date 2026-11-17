(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  let init = null;
  let rows = [];

  function textarea(value, onInput) {
    const t = el('textarea');
    t.value = value;
    t.spellcheck = false;
    t.addEventListener('input', onInput);
    return t;
  }

  function textInput(value, onInput, placeholder) {
    const t = el('input');
    t.type = 'text';
    t.value = value;
    if (placeholder) t.placeholder = placeholder;
    t.spellcheck = false;
    t.addEventListener('input', onInput);
    return t;
  }

  // Each editor returns { node, get() } where get() yields the serialisable value ({text} or {externals}).
  function editorFor(name, value, mark) {
    if (name === 'svn:externals') return externalsEditor(init.externals.defs, mark);
    if (name === 'svn:keywords') return keywordsEditor(value, mark);
    if (name === 'svn:eol-style') {
      const s = el('select');
      const cur = value.trim();
      const opts = init.eolStyles.slice();
      if (cur && !opts.includes(cur)) opts.unshift(cur);
      for (const o of opts) {
        const op = el('option', '', o);
        op.value = o;
        s.appendChild(op);
      }
      s.value = cur || opts[0];
      s.addEventListener('change', mark);
      return { node: s, get: () => ({ text: s.value }) };
    }
    if (name === 'svn:executable' || name === 'svn:needs-lock') {
      const wrap = el('div');
      wrap.appendChild(el('div', 'hint', 'A flag: any non-empty value (conventionally *) turns it on. Delete the property to turn it off.'));
      const i = textInput(value || '*', mark);
      wrap.appendChild(i);
      return { node: wrap, get: () => ({ text: i.value || '*' }) };
    }
    if (name === 'svn:mime-type') {
      const i = textInput(value, mark, 'e.g. text/plain or application/octet-stream');
      return { node: i, get: () => ({ text: i.value.trim() }) };
    }
    const ignore = name === 'svn:ignore' || name === 'svn:global-ignores';
    const t = textarea(value, mark);
    const wrap = el('div');
    if (ignore) wrap.appendChild(el('div', 'hint', 'One pattern per line (e.g. *.log, build). Applies to files directly in this folder' + (name === 'svn:global-ignores' ? ' and below.' : '.')));
    wrap.appendChild(t);
    return { node: wrap, get: () => ({ text: t.value, lines: ignore }) };
  }

  function keywordsEditor(value, mark) {
    const wrap = el('div');
    const cur = value.split(/[\s,]+/).filter(Boolean);
    const boxes = [];
    for (const k of init.keywords) {
      const l = el('label', 'kw');
      const c = el('input');
      c.type = 'checkbox';
      c.checked = cur.includes(k);
      c.addEventListener('change', mark);
      boxes.push([k, c]);
      l.appendChild(c);
      l.appendChild(document.createTextNode(k));
      wrap.appendChild(l);
    }
    const extra = textInput(cur.filter((k) => !init.keywords.includes(k)).join(' '), mark, 'other keywords, space separated');
    wrap.appendChild(extra);
    return {
      node: wrap,
      get: () => ({ text: boxes.filter(([, c]) => c.checked).map(([k]) => k).concat(extra.value.split(/\s+/).filter(Boolean)).join(' ') }),
    };
  }

  function externalsEditor(defs, mark) {
    const wrap = el('div');
    wrap.appendChild(el('div', 'hint', 'URL may be absolute, ^/relative-to-repo-root, //scheme-relative or ../relative. Peg and revision are optional.'));
    const table = el('table');
    const head = el('tr');
    for (const h of ['URL', 'Peg rev', 'Rev (-r)', 'Local directory', '']) head.appendChild(el('th', '', h));
    table.appendChild(head);
    const list = [];
    const addRow = (d) => {
      const tr = el('tr');
      const cell = (inp, narrow) => {
        const td = el('td', narrow ? 'narrow' : '');
        td.appendChild(inp);
        tr.appendChild(td);
        return inp;
      };
      const r = {
        url: cell(textInput(d.url || '', mark, 'svn://host/repo/path')),
        peg: cell(textInput(d.peg || '', mark), true),
        rev: cell(textInput(d.rev || '', mark), true),
        dir: cell(textInput(d.dir || '', mark, 'folder-name')),
        tr,
      };
      const td = el('td');
      const del = el('button', 'danger', 'Remove');
      del.addEventListener('click', () => {
        tr.remove();
        list.splice(list.indexOf(r), 1);
        mark();
      });
      td.appendChild(del);
      tr.appendChild(td);
      list.push(r);
      table.appendChild(tr);
    };
    defs.forEach(addRow);
    wrap.appendChild(table);
    const add = el('button', '', 'Add external');
    add.addEventListener('click', () => {
      addRow({});
      mark();
    });
    wrap.appendChild(add);
    return { node: wrap, get: () => ({ externals: list.map((r) => ({ url: r.url.value.trim(), peg: r.peg.value.trim() || undefined, rev: r.rev.value.trim() || undefined, dir: r.dir.value.trim() })) }) };
  }

  const serial = (v) => JSON.stringify(v);

  function addCard(name, value, isNew) {
    const card = el('div', 'card' + (isNew ? ' dirty' : ''));
    const head = el('div', 'head');
    head.appendChild(el('span', 'name', name));
    if (isNew) head.appendChild(el('span', 'tag', 'new'));
    const del = el('button', 'danger', 'Delete');
    head.appendChild(del);
    const body = el('div', 'body');
    card.appendChild(head);
    card.appendChild(body);
    const row = { name, isNew, deleted: false, card };
    const mark = () => card.classList.add('dirty');
    const ed = editorFor(name, value, mark);
    body.appendChild(ed.node);
    row.get = ed.get;
    row.orig = isNew ? undefined : serial(ed.get());
    del.addEventListener('click', () => {
      row.deleted = !row.deleted;
      card.classList.toggle('deleted', row.deleted);
      del.textContent = row.deleted ? 'Undo delete' : 'Delete';
      if (row.isNew && row.deleted) {
        card.remove();
        rows.splice(rows.indexOf(row), 1);
      }
    });
    rows.push(row);
    $('cards').appendChild(card);
  }

  function render() {
    $('cards').textContent = '';
    rows = [];
    $('title').textContent = 'Properties: ' + init.rel;
    $('sub').textContent = init.path + (init.isDir ? ' (folder)' : ' (file)');
    for (const p of init.props) addCard(p.name, p.value, false);
    $('empty').classList.toggle('hidden', rows.length > 0);
    $('recursiveBar').classList.toggle('hidden', !init.isDir);
    const dl = $('names');
    dl.textContent = '';
    for (const n of init.suggest) {
      const o = el('option');
      o.value = n;
      dl.appendChild(o);
    }
    $('error').textContent = init.error || '';
  }

  $('addBtn').addEventListener('click', () => {
    const name = $('newName').value.trim();
    if (!name) return;
    if (rows.some((r) => r.name === name && !r.deleted)) {
      $('error').textContent = name + ' already exists below: edit it instead.';
      return;
    }
    $('error').textContent = '';
    $('empty').classList.add('hidden');
    addCard(name, name === 'svn:executable' || name === 'svn:needs-lock' ? '*' : '', true);
    $('newName').value = '';
  });
  $('save').addEventListener('click', () => {
    const changes = [];
    for (const r of rows) {
      if (r.deleted) {
        if (!r.isNew) changes.push({ name: r.name });
        continue;
      }
      const v = r.get();
      if (r.isNew || serial(v) !== r.orig) changes.push(Object.assign({ name: r.name }, v));
    }
    if (!changes.length) {
      $('error').textContent = 'Nothing changed.';
      return;
    }
    $('save').disabled = true;
    vscode.postMessage({ type: 'save', changes, recursive: $('recursive').checked });
  });
  $('reload').addEventListener('click', () => vscode.postMessage({ type: 'reload' }));

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'init') {
      init = m;
      render();
      $('save').disabled = false;
    } else if (m.type === 'error') {
      $('error').textContent = m.text;
      $('save').disabled = false;
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
